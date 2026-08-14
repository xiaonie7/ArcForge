use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use chrono::Local;
use regex::Regex;
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio_cron_scheduler::{Job, JobScheduler};
use uuid::Uuid;

use crate::runtime::shell_runner::{run_shell_script, ShellRunResponse};
use crate::runtime::task_runner::{
    build_http_client, resolve_workdir, run_single_http_request, HttpExecutionFailure,
    HttpExecutionResult, HttpRequestInput,
};
use crate::services::local_wecom::LocalWecomSupervisor;

use super::db::now_ms;
use super::store::{AutomationStore, PromptQueueOutcome};
use super::types::{
    CompletedRun, CronRunNowResponse, CronTask, DeliveryJob, DeliveryStatus, HttpRequestSpec,
};

const SWEEP_INTERVAL: Duration = Duration::from_secs(30);
const DELIVERY_STATUS_UPDATE_ATTEMPTS: usize = 3;
const DELIVERY_STATUS_UPDATE_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
struct ScheduledJob {
    job_id: Uuid,
    cron: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunTrigger {
    Scheduled,
    Manual,
}

impl RunTrigger {
    fn counted(self) -> bool {
        matches!(self, Self::Scheduled)
    }
}

pub struct AutomationScheduler {
    store: Arc<AutomationStore>,
    scheduler: AsyncMutex<Option<JobScheduler>>,
    jobs: AsyncMutex<HashMap<String, ScheduledJob>>,
    active_runs: Mutex<HashSet<String>>,
    wecom_supervisor: Mutex<Option<Weak<LocalWecomSupervisor>>>,
    reload_notify: Notify,
    reload_pending: AtomicBool,
}

impl AutomationScheduler {
    pub fn new(store: Arc<AutomationStore>) -> Self {
        Self {
            store,
            scheduler: AsyncMutex::new(None),
            jobs: AsyncMutex::new(HashMap::new()),
            active_runs: Mutex::new(HashSet::new()),
            wecom_supervisor: Mutex::new(None),
            reload_notify: Notify::new(),
            reload_pending: AtomicBool::new(false),
        }
    }

    pub fn attach_wecom_supervisor(&self, supervisor: &Arc<LocalWecomSupervisor>) {
        if let Ok(mut guard) = self.wecom_supervisor.lock() {
            *guard = Some(Arc::downgrade(supervisor));
        }
    }

    pub fn start(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            self.run_loop().await;
        });
    }

    pub fn request_reload(&self) {
        self.reload_pending.store(true, Ordering::SeqCst);
        self.reload_notify.notify_one();
    }

    async fn run_loop(self: Arc<Self>) {
        {
            let store = Arc::clone(&self.store);
            let recovered = tauri::async_runtime::spawn_blocking(move || {
                store.recover_interrupted_deliveries()
            })
            .await;
            match recovered {
                Ok(Ok(count)) if count > 0 => {
                    eprintln!("automation: failed {count} delivery job(s) interrupted by restart");
                }
                Ok(Err(error)) => eprintln!("automation delivery recovery failed: {error}"),
                Err(error) => eprintln!("automation delivery recovery join failed: {error}"),
                _ => {}
            }
        }

        {
            let store = Arc::clone(&self.store);
            let recovered = tauri::async_runtime::spawn_blocking(move || {
                store.recover_interrupted_prompt_runs()
            })
            .await;
            match recovered {
                Ok(Ok(count)) if count > 0 => {
                    eprintln!("automation: expired {count} prompt run(s) interrupted by restart");
                }
                Ok(Err(error)) => eprintln!("automation prompt run recovery failed: {error}"),
                Err(error) => eprintln!("automation prompt run recovery join failed: {error}"),
                _ => {}
            }
        }

        if let Err(error) = self.ensure_scheduler().await {
            eprintln!("启动 automation scheduler 失败：{error}");
            return;
        }
        self.request_reload();

        let mut sweep = tokio::time::interval(SWEEP_INTERVAL);
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = self.reload_notify.notified() => {
                    while self.reload_pending.swap(false, Ordering::SeqCst) {
                        if let Err(error) = self.reload().await {
                            eprintln!("热重载 automation cron 任务失败：{error}");
                        }
                    }
                }
                _ = sweep.tick() => {
                    let store = Arc::clone(&self.store);
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        store.sweep_expired_prompt_runs()
                    })
                    .await;
                    match result {
                        Ok(Err(error)) => eprintln!("automation prompt sweep failed: {error}"),
                        Err(error) => eprintln!("automation prompt sweep join failed: {error}"),
                        _ => {}
                    }
                }
            }
        }
    }

    async fn ensure_scheduler(&self) -> Result<(), String> {
        let mut guard = self.scheduler.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let scheduler = JobScheduler::new()
            .await
            .map_err(|e| format!("创建 cron scheduler 失败：{e}"))?;
        scheduler
            .start()
            .await
            .map_err(|e| format!("启动 cron scheduler 失败：{e}"))?;
        *guard = Some(scheduler);
        Ok(())
    }

    /// Diff-based reload: only touched tasks are removed/added, and a task
    /// with an unparsable schedule only disables itself (recorded in
    /// `last_error`) instead of freezing the whole scheduler.
    async fn reload(self: &Arc<Self>) -> Result<(), String> {
        self.ensure_scheduler().await?;

        let store = Arc::clone(&self.store);
        let tasks = tauri::async_runtime::spawn_blocking(move || store.runnable_cron_tasks())
            .await
            .map_err(|e| format!("automation reload join 失败：{e}"))??;

        let desired: HashMap<String, CronTask> = tasks
            .into_iter()
            .map(|task| (task.id.clone(), task))
            .collect();

        let mut scheduler_guard = self.scheduler.lock().await;
        let scheduler = scheduler_guard
            .as_mut()
            .ok_or_else(|| "cron scheduler 尚未初始化".to_string())?;
        let mut jobs = self.jobs.lock().await;

        let stale: Vec<String> = jobs
            .iter()
            .filter(|(task_id, scheduled)| {
                desired
                    .get(*task_id)
                    .map(|task| task.cron.trim() != scheduled.cron)
                    .unwrap_or(true)
            })
            .map(|(task_id, _)| task_id.clone())
            .collect();
        for task_id in stale {
            let Some(scheduled) = jobs.get(&task_id).cloned() else {
                continue;
            };
            match scheduler.remove(&scheduled.job_id).await {
                Ok(()) => {
                    jobs.remove(&task_id);
                }
                Err(error) => {
                    // Keep the map entry so the next reload retries the
                    // removal — dropping it here would orphan a live job.
                    eprintln!("移除 cron 任务失败：{task_id} ({error})");
                }
            }
        }

        for (task_id, task) in &desired {
            if jobs.contains_key(task_id) {
                continue;
            }
            let cron_expr = task.cron.trim().to_string();
            let job = {
                let manager = Arc::clone(self);
                let task_id = task_id.clone();
                // Only the id is captured: the task itself (and its workdir)
                // is re-read from the store at fire time, so edits that keep
                // the cron expression apply to the next fire without a job
                // rebuild.
                Job::new_async_tz(cron_expr.as_str(), Local, move |_job_id, _lock| {
                    let manager = Arc::clone(&manager);
                    let task_id = task_id.clone();
                    Box::pin(async move {
                        manager.fire(task_id).await;
                    })
                })
            };
            match job {
                Ok(job) => {
                    let job_id = job.guid();
                    match scheduler.add(job).await {
                        Ok(_) => {
                            jobs.insert(
                                task_id.clone(),
                                ScheduledJob {
                                    job_id,
                                    cron: cron_expr,
                                },
                            );
                            self.report_task_error(task_id, None);
                        }
                        Err(error) => {
                            self.report_task_error(
                                task_id,
                                Some(format!("注册 Cron 任务失败：{error}")),
                            );
                        }
                    }
                }
                Err(error) => {
                    self.report_task_error(task_id, Some(format!("无效 Cron 表达式：{error}")));
                }
            }
        }

        Ok(())
    }

    fn report_task_error(self: &Arc<Self>, task_id: &str, error: Option<String>) {
        let store = Arc::clone(&self.store);
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            let result = tauri::async_runtime::spawn_blocking(move || {
                store.set_task_error(&task_id, error.as_deref())
            })
            .await;
            match result {
                Ok(Err(error)) => eprintln!("记录 cron 任务错误失败：{error}"),
                Err(error) => eprintln!("记录 cron 任务错误 join 失败：{error}"),
                _ => {}
            }
        });
    }

    async fn fire(self: &Arc<Self>, task_id: String) {
        let fresh = {
            let store = Arc::clone(&self.store);
            let task_id = task_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                store.cron_task_for_scheduled_fire(&task_id)
            })
            .await
        };
        match fresh {
            Ok(Ok(Some((workdir, task)))) => {
                if !self.start_fire(task.clone(), workdir, RunTrigger::Scheduled) {
                    self.record_run_detached(skipped_run(&task.id));
                }
            }
            // Task deleted since the job was registered; the next reload
            // drops the job.
            Ok(Ok(None)) => {}
            Ok(Err(error)) => {
                self.record_run_detached(failed_run(
                    &task_id,
                    format!("Cron task fire read failed: {error}"),
                    false,
                ));
            }
            Err(error) => {
                self.record_run_detached(failed_run(
                    &task_id,
                    format!("Cron task fire read join failed: {error}"),
                    false,
                ));
            }
        }
    }

    pub fn run_now(self: &Arc<Self>, task_id: &str) -> Result<CronRunNowResponse, String> {
        let (workdir, task) = self.store.cron_task_for_manual_run(task_id)?;
        let started_at = now_ms();
        if !self.start_fire(task, workdir, RunTrigger::Manual) {
            return Err("Cron task is already running.".to_string());
        }
        Ok(CronRunNowResponse { started_at })
    }

    fn start_fire(self: &Arc<Self>, task: CronTask, workdir: String, trigger: RunTrigger) -> bool {
        {
            let mut active = match self.active_runs.lock() {
                Ok(guard) => guard,
                Err(_) => return false,
            };
            if !active.insert(task.id.clone()) {
                return false;
            }
        }

        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            manager.execute_fire(task, workdir, trigger).await;
        });
        true
    }

    async fn execute_fire(self: Arc<Self>, task: CronTask, workdir: String, trigger: RunTrigger) {
        let task_id = task.id.clone();

        if trigger == RunTrigger::Scheduled {
            let can_run = {
                let store = Arc::clone(&self.store);
                let task_id = task_id.clone();
                tauri::async_runtime::spawn_blocking(move || store.task_can_run(&task_id)).await
            };
            match can_run {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => {
                    self.clear_active(&task_id);
                    return;
                }
                Ok(Err(error)) => {
                    self.record_run_detached(failed_run(
                        &task_id,
                        format!("Cron task state check failed: {error}"),
                        false,
                    ));
                    self.clear_active(&task_id);
                    return;
                }
                Err(error) => {
                    self.record_run_detached(failed_run(
                        &task_id,
                        format!("Cron task state check join failed: {error}"),
                        false,
                    ));
                    self.clear_active(&task_id);
                    return;
                }
            }
        }

        // A pinned workspace must exist before any execution; a vanished pin
        // fails this run and disables the task so it stops re-firing into a
        // directory that no longer exists. Follow-global tasks keep the
        // legacy behavior (bash/prompt fail the run without disabling).
        let workdir = match task.workdir.as_deref().map(str::trim) {
            Some(pin) if !pin.is_empty() => match resolve_workdir(Some(pin.to_string())) {
                Ok(resolved) => resolved.display().to_string(),
                Err(error) => {
                    let message = format!("Cron task workspace is unavailable ({pin}): {error}");
                    self.record_run_with_delivery(
                        &task,
                        failed_run(&task_id, message.clone(), trigger.counted()),
                    )
                    .await;
                    self.disable_task_detached(&task_id, message);
                    self.clear_active(&task_id);
                    return;
                }
            },
            _ => workdir,
        };

        if task.kind == "prompt" {
            let store = Arc::clone(&self.store);
            let queue_task = task.clone();
            let queue_workdir = workdir.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                store.queue_prompt_run(&queue_task, &queue_workdir, trigger.counted())
            })
            .await;
            match result {
                Ok(Ok(PromptQueueOutcome::Queued)) => {}
                Ok(Ok(PromptQueueOutcome::SkippedActiveRun)) => {
                    self.record_run_detached(skipped_run(&task_id));
                }
                Ok(Err(error)) => {
                    self.record_run_with_delivery(
                        &task,
                        failed_run(&task_id, error, trigger.counted()),
                    )
                    .await;
                }
                Err(error) => {
                    self.record_run_with_delivery(
                        &task,
                        failed_run(
                            &task_id,
                            format!("Cron prompt queue join failed: {error}"),
                            false,
                        ),
                    )
                    .await;
                }
            }
            // The prompt run row owns the task's activity from here on.
            self.clear_active(&task_id);
            return;
        }

        let execution_task = task.clone();
        let run = tauri::async_runtime::spawn_blocking(move || {
            let mut run = execute_blocking(execution_task, workdir);
            run.counted = trigger.counted();
            run
        })
        .await
        .unwrap_or_else(|error| {
            failed_run(
                &task_id,
                format!("Cron task execution join failed: {error}"),
                false,
            )
        });
        self.record_run_with_delivery(&task, run).await;
        self.clear_active(&task_id);
    }

    fn clear_active(&self, task_id: &str) {
        if let Ok(mut active) = self.active_runs.lock() {
            active.remove(task_id);
        }
    }

    fn disable_task_detached(&self, task_id: &str, error: String) {
        let store = Arc::clone(&self.store);
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            let result = tauri::async_runtime::spawn_blocking(move || {
                store.disable_task_with_error(&task_id, &error)
            })
            .await;
            match result {
                Ok(Err(error)) => eprintln!("禁用 cron 任务失败：{error}"),
                Err(error) => eprintln!("禁用 cron 任务 join 失败：{error}"),
                _ => {}
            }
        });
    }

    async fn record_run_with_delivery(&self, task: &CronTask, run: CompletedRun) {
        let delivery = task.delivery.clone();
        let delivery_status = delivery.as_ref().map(|config| {
            if config.only_on.matches(run.success) {
                DeliveryStatus::Pending
            } else {
                DeliveryStatus::Skipped
            }
        });
        let job_parts = delivery
            .filter(|config| config.only_on.matches(run.success))
            .map(|config| {
                (
                    task.name.clone(),
                    run.success,
                    run.started_at,
                    run.duration_ms,
                    run.output.clone(),
                    config,
                )
            });
        let task_id = run.task_id.clone();
        let store = Arc::clone(&self.store);
        let execution_id = tauri::async_runtime::spawn_blocking(move || {
            store.record_completed_run_with_delivery(run, delivery_status, None)
        })
        .await;
        let execution_id = match execution_id {
            Ok(Ok(execution_id)) => execution_id,
            Ok(Err(error)) => {
                eprintln!("Cron run record failed: {error}");
                return;
            }
            Err(error) => {
                eprintln!("Cron run record join failed: {error}");
                return;
            }
        };
        if let Some((task_name, success, started_at, duration_ms, output, config)) = job_parts {
            self.deliver(DeliveryJob {
                execution_id,
                task_id,
                task_name,
                success,
                started_at,
                duration_ms,
                output,
                config,
            })
            .await;
        }
    }

    pub async fn deliver(&self, job: DeliveryJob) {
        let supervisor = self
            .wecom_supervisor
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
            .and_then(|supervisor| supervisor.upgrade());
        let result = match supervisor {
            Some(supervisor) if job.config.channel == "wecom" => {
                let content = format_delivery_markdown(&job);
                let mut attempt = 0;
                loop {
                    let result = supervisor
                        .send_markdown(job.config.target_id.clone(), content.clone())
                        .await
                        .map(|_| ());
                    match result {
                        Err(error) if attempt < 9 && is_transient_delivery_error(&error) => {
                            attempt += 1;
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                        result => break result,
                    }
                }
            }
            Some(_) => Err("unsupported delivery channel".to_string()),
            None => Err("WeCom runtime unavailable".to_string()),
        };
        let (status, error) = match result {
            Ok(()) => (DeliveryStatus::Sent, None),
            Err(raw_error) => {
                let safe_error = safe_delivery_error(&raw_error);
                eprintln!(
                    "automation delivery failed for task {}: {}",
                    job.task_id, safe_error
                );
                (DeliveryStatus::Failed, Some(safe_error))
            }
        };
        self.persist_delivery_result(job.execution_id, status, error)
            .await;
    }

    async fn persist_delivery_result(
        &self,
        execution_id: String,
        status: DeliveryStatus,
        error: Option<String>,
    ) {
        let mut last_error = None;
        for attempt in 0..DELIVERY_STATUS_UPDATE_ATTEMPTS {
            let store = Arc::clone(&self.store);
            let execution_id = execution_id.clone();
            let error = error.clone();
            let updated = tauri::async_runtime::spawn_blocking(move || {
                store.update_run_delivery(&execution_id, status, error.as_deref())
            })
            .await;
            match updated {
                Ok(Ok(())) => return,
                Ok(Err(error)) => last_error = Some(error),
                Err(error) => {
                    last_error = Some(format!("delivery status update task failed: {error}"));
                }
            }
            if attempt + 1 < DELIVERY_STATUS_UPDATE_ATTEMPTS {
                tokio::time::sleep(DELIVERY_STATUS_UPDATE_RETRY_DELAY).await;
            }
        }
        if let Some(error) = last_error {
            eprintln!("update Cron delivery status failed after retries: {error}");
        }
    }

    fn record_run_detached(&self, run: CompletedRun) {
        let store = Arc::clone(&self.store);
        tauri::async_runtime::spawn(async move {
            let result =
                tauri::async_runtime::spawn_blocking(move || store.record_completed_run(run)).await;
            match result {
                Ok(Err(error)) => eprintln!("Cron run 记录失败：{error}"),
                Err(error) => eprintln!("Cron run 记录 join 失败：{error}"),
                _ => {}
            }
        });
    }
}

const DELIVERY_OUTPUT_INPUT_MAX_BYTES: usize = 4 * 1024;
const DELIVERY_OUTPUT_MAX_BYTES: usize = 8 * 1024;
const DELIVERY_INLINE_MAX_BYTES: usize = 512;
const DELIVERY_MESSAGE_MAX_BYTES: usize = 12 * 1024;

fn format_delivery_markdown(job: &DeliveryJob) -> String {
    let status = if job.success { "Success" } else { "Failure" };
    let task_name = escape_markdown_inline(&truncate_utf8_bytes(
        job.task_name.trim(),
        DELIVERY_INLINE_MAX_BYTES,
    ));
    let task_id = escape_markdown_inline(&truncate_utf8_bytes(
        job.task_id.trim(),
        DELIVERY_INLINE_MAX_BYTES,
    ));
    let safe_output = sanitize_delivery_output(job.output.trim());
    let bounded_output = truncate_utf8_bytes(&safe_output, DELIVERY_OUTPUT_INPUT_MAX_BYTES);
    let output = truncate_utf8_bytes(
        &break_markdown_fences(&bounded_output),
        DELIVERY_OUTPUT_MAX_BYTES,
    );
    let message = format!(
        "### ArcForge Automation: {}\n\n- Status: {}\n- Started at: {}\n- Duration: {} ms\n- Task ID: {}\n\n```text\n{}\n```",
        task_name,
        status,
        job.started_at,
        job.duration_ms,
        task_id,
        output,
    );
    debug_assert!(message.len() <= DELIVERY_MESSAGE_MAX_BYTES);
    message
}

fn escape_markdown_inline(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\n' | '\r' => escaped.push(' '),
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '(' | ')' | '#' | '+' | '-' | '.'
            | '!' | '>' | '|' | '~' => {
                escaped.push('\\');
                escaped.push(character);
            }
            character if character.is_control() => {}
            character => escaped.push(character),
        }
    }
    escaped
}

fn sanitize_delivery_output(value: &str) -> String {
    static ANSI_ESCAPE: OnceLock<Regex> = OnceLock::new();
    let ansi_escape = ANSI_ESCAPE.get_or_init(|| {
        Regex::new(r"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))")
            .expect("valid ANSI escape regex")
    });
    ansi_escape
        .replace_all(value, "")
        .chars()
        .filter(|character| {
            let code_point = *character as u32;
            matches!(*character, '\n' | '\r' | '\t')
                || !(code_point < 32 || (127..=159).contains(&code_point))
        })
        .collect()
}

fn break_markdown_fences(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    let mut consecutive_backticks = 0;
    for character in value.chars() {
        if character == '`' {
            if consecutive_backticks == 2 {
                escaped.push('\\');
                consecutive_backticks = 0;
            }
            escaped.push(character);
            consecutive_backticks += 1;
        } else {
            escaped.push(character);
            consecutive_backticks = 0;
        }
    }
    escaped
}

fn is_transient_delivery_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("not running")
        || normalized.contains("not authenticated")
        || normalized.contains("not_authenticated")
        || normalized.contains("unavailable")
        || normalized.contains("waiting to be sent")
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let suffix = "\n...[truncated]";
    let mut end = max_bytes.saturating_sub(suffix.len()).min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut truncated = value[..end].to_string();
    truncated.push_str(suffix);
    truncated
}

fn safe_delivery_error(raw_error: &str) -> String {
    let normalized = raw_error.to_ascii_lowercase();
    if normalized.contains("timed out") {
        "WeCom delivery timed out".to_string()
    } else if normalized.contains("unavailable")
        || normalized.contains("stopped")
        || normalized.contains("not running")
        || normalized.contains("not authenticated")
        || normalized.contains("not_authenticated")
    {
        "WeCom runtime is unavailable".to_string()
    } else {
        "WeCom delivery failed".to_string()
    }
}

fn skipped_run(task_id: &str) -> CompletedRun {
    CompletedRun {
        task_id: task_id.to_string(),
        success: false,
        started_at: now_ms(),
        duration_ms: 0,
        exit_code: None,
        output: "Skipped: previous run is still in progress.".to_string(),
        counted: false,
    }
}

fn failed_run(task_id: &str, message: String, counted: bool) -> CompletedRun {
    CompletedRun {
        task_id: task_id.to_string(),
        success: false,
        started_at: now_ms(),
        duration_ms: 0,
        exit_code: None,
        output: message,
        counted,
    }
}

fn execute_blocking(task: CronTask, workdir: String) -> CompletedRun {
    match task.kind.as_str() {
        "bash" => execute_bash(&task, workdir),
        "http" => execute_http(&task),
        other => failed_run(
            &task.id,
            format!("Unsupported cron task kind: {other}"),
            false,
        ),
    }
}

fn execute_bash(task: &CronTask, workdir: String) -> CompletedRun {
    let started_at = now_ms();
    let overall = Instant::now();
    let script = task
        .script
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if script.is_empty() {
        return failed_run(
            &task.id,
            "No Bash script configured for this Cron task.".to_string(),
            true,
        );
    }
    if workdir.trim().is_empty() {
        return failed_run(
            &task.id,
            "Cron bash task requires a project workdir (System -> Workdir).".to_string(),
            true,
        );
    }
    let cwd = match resolve_workdir(Some(workdir)) {
        Ok(cwd) => cwd,
        Err(error) => return failed_run(&task.id, error, true),
    };
    let result = match run_shell_script(
        cwd.display().to_string(),
        script.clone(),
        None,
        Some(task.timeout_seconds.saturating_mul(1_000)),
        None,
        None,
        None,
    ) {
        Ok(result) => result,
        Err(error) => return failed_run(&task.id, error, true),
    };

    CompletedRun {
        task_id: task.id.clone(),
        success: result.exit_code == 0 && !result.timed_out,
        started_at,
        duration_ms: overall.elapsed().as_millis() as u64,
        exit_code: Some(result.exit_code),
        output: format_shell_result(&script, &result),
        counted: true,
    }
}

fn execute_http(task: &CronTask) -> CompletedRun {
    let started_at = now_ms();
    let overall = Instant::now();
    let requests = task.requests.clone().unwrap_or_default();
    if requests.is_empty() {
        return failed_run(
            &task.id,
            "No HTTP requests configured for this Cron task.".to_string(),
            true,
        );
    }
    let client = match build_http_client(Some(task.timeout_seconds.saturating_mul(1_000))) {
        Ok(client) => client,
        Err(error) => return failed_run(&task.id, error, true),
    };

    let mut sections = Vec::new();
    let mut success = true;
    for (index, request) in requests.into_iter().enumerate() {
        let display = format!(
            "{} {}",
            request.method.trim().to_uppercase(),
            request.url.trim()
        );
        match run_single_http_request(&client, to_http_input(request)) {
            Ok(result) => sections.push(format_http_result(index + 1, &display, &result)),
            Err(error) => {
                success = false;
                sections.push(format_http_failure(index + 1, &display, &error));
            }
        }
    }

    CompletedRun {
        task_id: task.id.clone(),
        success,
        started_at,
        duration_ms: overall.elapsed().as_millis() as u64,
        exit_code: None,
        output: sections.join("\n\n"),
        counted: true,
    }
}

#[cfg(test)]
mod delivery_tests {
    use super::*;
    use crate::services::automation::{DeliveryConfig, DeliveryOnlyOn};

    fn job(output: String) -> DeliveryJob {
        DeliveryJob {
            execution_id: "run-1".to_string(),
            task_id: "task-1".to_string(),
            task_name: "Weekly report".to_string(),
            success: true,
            started_at: 100,
            duration_ms: 25,
            output,
            config: DeliveryConfig {
                channel: "wecom".to_string(),
                target_id: "project-room".to_string(),
                only_on: DeliveryOnlyOn::Always,
            },
        }
    }

    #[test]
    fn delivery_markdown_is_bounded_on_utf8_boundary() {
        let markdown = format_delivery_markdown(&job("报告".repeat(10_000)));
        assert!(markdown.len() <= DELIVERY_MESSAGE_MAX_BYTES);
        assert!(markdown.contains("...[truncated]"));
    }

    #[test]
    fn delivery_error_never_persists_connector_details() {
        let raw = "connector response token=secret body=private";
        let safe = safe_delivery_error(raw);
        assert_eq!(safe, "WeCom delivery failed");
        assert!(!safe.contains("secret"));
        assert!(!safe.contains("private"));
    }

    #[test]
    fn delivery_retry_excludes_outcome_unknown_connector_failures() {
        assert!(is_transient_delivery_error(
            "WeCom Connector is not running"
        ));
        assert!(is_transient_delivery_error(
            "WeCom Connector is not authenticated"
        ));
        assert!(is_transient_delivery_error("not_authenticated"));
        assert!(is_transient_delivery_error(
            "Too many WeCom messages are waiting to be sent"
        ));
        assert!(!is_transient_delivery_error(
            "WeCom Connector stopped before acknowledging the message"
        ));
        assert!(!is_transient_delivery_error(
            "Timed out waiting for WeCom to acknowledge the message"
        ));
    }

    #[test]
    fn delivery_markdown_escapes_fields_and_cannot_close_output_fence() {
        let mut delivery = job("before\n```\n# injected\n```\nafter".to_string());
        delivery.task_name = "Report\n# forged [link](https://example.com)".to_string();
        delivery.task_id = "task`id".to_string();
        let markdown = format_delivery_markdown(&delivery);
        assert!(markdown.contains("Report \\# forged \\[link\\]\\(https://example\\.com\\)"));
        assert!(markdown.contains("Task ID: task\\`id"));
        assert!(markdown.contains("``\\`"));
        assert_eq!(markdown.matches("```").count(), 2);
    }

    #[test]
    fn delivery_markdown_strips_ansi_and_forbidden_control_characters() {
        let markdown = format_delivery_markdown(&job(
            "\x1b[31mred\x1b[0m\0still here\u{0085}\nnext".to_string(),
        ));
        assert!(markdown.contains("redstill here\nnext"));
        assert!(!markdown.chars().any(|character| {
            let code_point = character as u32;
            !matches!(character, '\n' | '\r' | '\t')
                && (code_point < 32 || (127..=159).contains(&code_point))
        }));
    }

    #[test]
    fn delivery_markdown_keeps_closing_fence_with_oversized_fields() {
        let mut delivery = job("```".repeat(20_000));
        delivery.task_name = "[# oversized]".repeat(10_000);
        delivery.task_id = "`task`".repeat(10_000);
        let markdown = format_delivery_markdown(&delivery);
        assert!(markdown.len() <= DELIVERY_MESSAGE_MAX_BYTES);
        assert!(markdown.ends_with("\n```"));
        assert_eq!(markdown.matches("```").count(), 2);
    }
}

pub fn to_http_input(request: HttpRequestSpec) -> HttpRequestInput {
    HttpRequestInput {
        id: request.id,
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
    }
}

fn format_shell_result(script: &str, result: &ShellRunResponse) -> String {
    let mut lines = vec![
        format!("shell={}", result.shell),
        format!("exit={}", result.exit_code),
        format!("timed_out={}", result.timed_out),
        format!("duration={}ms", result.duration_ms),
        "script:".to_string(),
        script.to_string(),
    ];
    if !result.stdout.trim().is_empty() {
        lines.push("stdout:".to_string());
        lines.push(result.stdout.trim().to_string());
    }
    if !result.stderr.trim().is_empty() {
        lines.push("stderr:".to_string());
        lines.push(result.stderr.trim().to_string());
    }
    if result.stdout_truncated {
        lines.push("stdout_truncated=true".to_string());
    }
    if result.stderr_truncated {
        lines.push("stderr_truncated=true".to_string());
    }
    lines.join("\n")
}

fn format_http_result(index: usize, display: &str, result: &HttpExecutionResult) -> String {
    let mut lines = vec![
        format!("Request {index}: {display}"),
        format!("status={}", result.status),
        format!("duration={}ms", result.duration_ms),
    ];
    if !result.response_body.trim().is_empty() {
        lines.push("response:".to_string());
        lines.push(result.response_body.trim().to_string());
    }
    lines.join("\n")
}

fn format_http_failure(index: usize, display: &str, error: &HttpExecutionFailure) -> String {
    [
        format!("Request {index}: {display}"),
        "status=failed".to_string(),
        format!("duration={}ms", error.duration_ms),
        error.to_string(),
    ]
    .join("\n")
}
