use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Condvar, Mutex,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use uuid::Uuid;

use crate::commands::settings::{
    load_remote_settings, load_wecom_runtime_settings, open_db, RemoteSettingsPayload,
    RuntimeWecomSettings, WecomGatewayMode,
};
use crate::runtime::process::{kill_child_process_tree_best_effort, terminate_child_process_tree};
use crate::services::gateway::GatewayController;

const STATUS_EVENT: &str = "wecom-runtime:status";
const GATEWAY_SIDECAR_STEM: &str = "arcforge-gateway";
const CONNECTOR_SIDECAR_STEM: &str = "arcforge-wecom-connector";
const CONNECTOR_READY_MARKER: &str = "__ARCFORGE_WECOM_CONNECTOR_READY_V1__";
const CONNECTOR_CONTROL_RESULT_PREFIX: &str = "__ARCFORGE_WECOM_CONTROL_RESULT_V1__";
const LOG_LINE_LIMIT: usize = 500;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECTOR_STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_INTERVAL: Duration = Duration::from_secs(2);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(750);
const HEALTH_FAILURE_LIMIT: u32 = 3;
const PROCESS_STABLE_AFTER: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const LOOP_INTERVAL: Duration = Duration::from_millis(250);
const OUTBOUND_SEND_TIMEOUT: Duration = Duration::from_secs(10);
const OUTBOUND_PENDING_LIMIT: usize = 32;
const OUTBOUND_CHAT_ID_MAX_LEN: usize = 256;
const OUTBOUND_CONTENT_MAX_BYTES: usize = 16 * 1024;

#[cfg(windows)]
struct RuntimeOwnershipGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl RuntimeOwnershipGuard {
    fn try_acquire() -> Result<Option<Self>, String> {
        use windows_sys::Win32::Foundation::{
            CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};

        let name = "Local\\ArcForge.WeComRuntime.v1"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "create WeCom runtime ownership mutex failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Some(Self { handle })),
            WAIT_TIMEOUT => {
                unsafe {
                    CloseHandle(handle);
                }
                Ok(None)
            }
            _ => {
                let error = std::io::Error::last_os_error();
                unsafe {
                    CloseHandle(handle);
                }
                Err(format!("acquire WeCom runtime ownership failed: {error}"))
            }
        }
    }
}

#[cfg(windows)]
impl Drop for RuntimeOwnershipGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;

        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
struct RuntimeOwnershipGuard;

#[cfg(not(windows))]
impl RuntimeOwnershipGuard {
    fn try_acquire() -> Result<Option<Self>, String> {
        Ok(Some(Self))
    }
}

#[cfg(windows)]
struct ChildProcessJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ChildProcessJob {
    fn new() -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "create WeCom child process job failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut information = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&information).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Err(format!("configure WeCom child process job failed: {error}"));
        }
        Ok(Self { handle })
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let assigned = unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as _) };
        if assigned == 0 {
            return Err(format!(
                "assign WeCom child process to crash cleanup job failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for ChildProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
struct ChildProcessJob;

#[cfg(not(windows))]
impl ChildProcessJob {
    fn new() -> Result<Self, String> {
        Ok(Self)
    }

    fn assign(&self, _child: &Child) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
fn configure_managed_child(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

    // A suspended process cannot create descendants before it belongs to the
    // kill-on-close Job Object.
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
}

#[cfg(not(windows))]
fn configure_managed_child(command: &mut Command) {
    crate::runtime::process::configure_child_process_group(command);
}

#[cfg(windows)]
fn resume_managed_child(child: &Child) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    for _ in 0..20 {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(format!(
                "inspect suspended WeCom child threads failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..THREADENTRY32::default()
        };
        let mut found = false;
        let mut iteration_ok = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while iteration_ok {
            if entry.th32OwnerProcessID == child.id() {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    let error = std::io::Error::last_os_error();
                    unsafe { CloseHandle(snapshot) };
                    return Err(format!("open suspended WeCom child thread failed: {error}"));
                }
                let previous_count = unsafe { ResumeThread(thread) };
                unsafe { CloseHandle(thread) };
                if previous_count == u32::MAX {
                    let error = std::io::Error::last_os_error();
                    unsafe { CloseHandle(snapshot) };
                    return Err(format!("resume WeCom child thread failed: {error}"));
                }
                found = true;
            }
            iteration_ok = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        if found {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(5));
    }

    Err("suspended WeCom child process did not expose a resumable thread".to_string())
}

#[cfg(not(windows))]
fn resume_managed_child(_child: &Child) -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalWecomStatus {
    pub mode: String,
    pub overall: String,
    pub gateway_state: String,
    pub connector_state: String,
    #[serde(rename = "localGatewayUrl")]
    pub gateway_url: Option<String>,
    pub gateway_pid: Option<u32>,
    pub connector_pid: Option<u32>,
    #[serde(rename = "gatewayRestarts")]
    pub gateway_restart_count: u32,
    #[serde(rename = "connectorRestarts")]
    pub connector_restart_count: u32,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

impl Default for LocalWecomStatus {
    fn default() -> Self {
        Self {
            mode: "external".to_string(),
            overall: "stopped".to_string(),
            gateway_state: "stopped".to_string(),
            connector_state: "stopped".to_string(),
            gateway_url: None,
            gateway_pid: None,
            connector_pid: None,
            gateway_restart_count: 0,
            connector_restart_count: 0,
            last_error: None,
            updated_at: now_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWecomLogs {
    pub gateway: String,
    pub connector: String,
    pub gateway_truncated: bool,
    pub connector_truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalWecomSendReceipt {
    pub request_id: String,
    pub chat_id: String,
    pub sent_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorSendRequest<'a> {
    v: u8,
    #[serde(rename = "type")]
    kind: &'static str,
    request_id: &'a str,
    chat_id: &'a str,
    content: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorSendResult {
    request_id: String,
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

struct PendingSend {
    generation: u64,
    completion: mpsc::Sender<Result<(), String>>,
}

struct ActiveConnectorControl {
    generation: u64,
    writer: Arc<Mutex<ChildStdin>>,
    ready: Arc<AtomicBool>,
}

#[derive(Default)]
struct OutboundState {
    generation: u64,
    connector: Option<ActiveConnectorControl>,
    pending: HashMap<String, PendingSend>,
}

#[derive(Debug, Clone)]
struct RuntimeConfig {
    wecom: RuntimeWecomSettings,
    remote: RemoteSettingsPayload,
}

impl RuntimeConfig {
    fn mode_name(&self) -> &'static str {
        match self.wecom.gateway_mode {
            WecomGatewayMode::Local => "local",
            WecomGatewayMode::External => "external",
        }
    }

    fn local_gateway_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.wecom.local_gateway_port)
    }

    fn connector_should_run(&self) -> bool {
        self.wecom.enabled
            && !self.wecom.bot_id.trim().is_empty()
            && !self.wecom.secret.trim().is_empty()
            && match self.wecom.gateway_mode {
                WecomGatewayMode::Local => true,
                WecomGatewayMode::External => {
                    !self.remote.gateway_url.trim().is_empty()
                        && !self.wecom.channel_token.trim().is_empty()
                }
            }
    }
}

#[derive(Default)]
struct LogBuffer {
    lines: VecDeque<String>,
    truncated: bool,
}

impl LogBuffer {
    fn push(&mut self, line: String) {
        if self.lines.len() >= LOG_LINE_LIMIT {
            self.lines.pop_front();
            self.truncated = true;
        }
        self.lines.push_back(line);
    }

    fn text(&self) -> String {
        self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

struct SharedState {
    desired: Option<RuntimeConfig>,
    revision: u64,
    restart_requested: bool,
    shutdown: bool,
    status: LocalWecomStatus,
    gateway_log: LogBuffer,
    connector_log: LogBuffer,
}

impl Default for SharedState {
    fn default() -> Self {
        Self {
            desired: None,
            revision: 0,
            restart_requested: false,
            shutdown: false,
            status: LocalWecomStatus::default(),
            gateway_log: LogBuffer::default(),
            connector_log: LogBuffer::default(),
        }
    }
}

struct SupervisorShared {
    state: Mutex<SharedState>,
    outbound: Mutex<OutboundState>,
    wake: Condvar,
}

pub struct LocalWecomSupervisor {
    app_handle: tauri::AppHandle,
    gateway_controller: Arc<GatewayController>,
    shared: Arc<SupervisorShared>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    agent_token: String,
    channel_token: String,
}

impl LocalWecomSupervisor {
    pub fn new(app_handle: tauri::AppHandle, gateway_controller: Arc<GatewayController>) -> Self {
        Self {
            app_handle,
            gateway_controller,
            shared: Arc::new(SupervisorShared {
                state: Mutex::new(SharedState::default()),
                outbound: Mutex::new(OutboundState::default()),
                wake: Condvar::new(),
            }),
            worker: Mutex::new(None),
            agent_token: generate_runtime_token("agent"),
            channel_token: generate_runtime_token("channel"),
        }
    }

    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| "WeCom runtime worker lock is unavailable".to_string())?;
        if worker.as_ref().is_some_and(|handle| handle.is_finished()) {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
        if worker.is_some() {
            return Ok(());
        }

        let shared = Arc::clone(&self.shared);
        let app_handle = self.app_handle.clone();
        let gateway_controller = Arc::clone(&self.gateway_controller);
        let agent_token = self.agent_token.clone();
        let channel_token = self.channel_token.clone();
        *worker = Some(
            thread::Builder::new()
                .name("arcforge-wecom-runtime".to_string())
                .spawn(move || {
                    worker_loop(
                        shared,
                        app_handle,
                        gateway_controller,
                        agent_token,
                        channel_token,
                    )
                })
                .map_err(|error| format!("start WeCom runtime worker failed: {error}"))?,
        );
        Ok(())
    }

    pub async fn reload_from_db(self: &Arc<Self>) -> Result<(), String> {
        self.start()?;
        let loaded = tauri::async_runtime::spawn_blocking(|| {
            let conn = open_db()?;
            Ok::<_, String>(RuntimeConfig {
                wecom: load_wecom_runtime_settings(&conn)?,
                remote: load_remote_settings(&conn)?,
            })
        })
        .await
        .map_err(|error| format!("reload WeCom runtime settings join failed: {error}"))??;

        if loaded.wecom.gateway_mode == WecomGatewayMode::External {
            self.gateway_controller
                .apply_config(loaded.remote.clone())?;
        } else {
            self.gateway_controller.disconnect_runtime()?;
        }

        let mode = loaded.mode_name().to_string();
        let gateway_url = (loaded.wecom.gateway_mode == WecomGatewayMode::Local)
            .then(|| loaded.local_gateway_url());
        {
            let mut state = self
                .shared
                .state
                .lock()
                .map_err(|_| "WeCom runtime state is unavailable".to_string())?;
            state.desired = Some(loaded);
            state.revision = state.revision.wrapping_add(1);
            state.status.mode = mode;
            state.status.gateway_url = gateway_url;
            state.status.last_error = None;
            state.status.updated_at = now_ms();
        }
        self.shared.wake.notify_all();
        Ok(())
    }

    pub fn is_local_mode(&self) -> bool {
        self.shared.state.lock().ok().and_then(|state| {
            state
                .desired
                .as_ref()
                .map(|config| config.wecom.gateway_mode)
        }) == Some(WecomGatewayMode::Local)
    }

    pub fn status(&self) -> LocalWecomStatus {
        self.shared
            .state
            .lock()
            .map(|state| state.status.clone())
            .unwrap_or_else(|_| LocalWecomStatus {
                overall: "error".to_string(),
                last_error: Some("WeCom runtime state is unavailable".to_string()),
                ..LocalWecomStatus::default()
            })
    }

    pub fn logs(&self) -> LocalWecomLogs {
        self.shared
            .state
            .lock()
            .map(|state| LocalWecomLogs {
                gateway: state.gateway_log.text(),
                connector: state.connector_log.text(),
                gateway_truncated: state.gateway_log.truncated,
                connector_truncated: state.connector_log.truncated,
            })
            .unwrap_or_else(|_| LocalWecomLogs {
                gateway: String::new(),
                connector: String::new(),
                gateway_truncated: false,
                connector_truncated: false,
            })
    }

    pub fn restart(self: &Arc<Self>) -> Result<LocalWecomStatus, String> {
        self.start()?;
        let status = {
            let mut state = self
                .shared
                .state
                .lock()
                .map_err(|_| "WeCom runtime state is unavailable".to_string())?;
            if state.desired.is_none() {
                return Err("The desktop-managed WeCom runtime is not configured".to_string());
            }
            state.restart_requested = true;
            state.status.overall = "starting".to_string();
            state.status.last_error = None;
            state.status.updated_at = now_ms();
            state.status.clone()
        };
        self.shared.wake.notify_all();
        let _ = self.app_handle.emit(STATUS_EVENT, &status);
        Ok(status)
    }

    pub async fn send_markdown(
        self: &Arc<Self>,
        chat_id: String,
        content: String,
    ) -> Result<LocalWecomSendReceipt, String> {
        let shared = Arc::clone(&self.shared);
        tauri::async_runtime::spawn_blocking(move || {
            send_markdown_blocking(&shared, chat_id, content)
        })
        .await
        .map_err(|error| format!("send WeCom message task failed: {error}"))?
    }

    pub fn shutdown_cleanup(&self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.shutdown = true;
        }
        self.shared.wake.notify_all();
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }
}

fn send_markdown_blocking(
    shared: &Arc<SupervisorShared>,
    chat_id: String,
    content: String,
) -> Result<LocalWecomSendReceipt, String> {
    let (chat_id, content) = validate_outbound_message(chat_id, content)?;
    let request_id = Uuid::new_v4().to_string();
    let request = ConnectorSendRequest {
        v: 1,
        kind: "send_markdown",
        request_id: &request_id,
        chat_id: &chat_id,
        content: &content,
    };
    let mut encoded = serde_json::to_vec(&request)
        .map_err(|error| format!("encode WeCom send request failed: {error}"))?;
    encoded.push(b'\n');
    let (completion_tx, completion_rx) = mpsc::channel();
    let (generation, writer) = {
        let mut outbound = shared
            .outbound
            .lock()
            .map_err(|_| "WeCom outbound state is unavailable".to_string())?;
        let connector = outbound
            .connector
            .as_ref()
            .ok_or_else(|| "WeCom Connector is not running".to_string())?;
        if !connector.ready.load(Ordering::Acquire) {
            return Err("WeCom Connector is not authenticated".to_string());
        }
        if outbound.pending.len() >= OUTBOUND_PENDING_LIMIT {
            return Err("Too many WeCom messages are waiting to be sent".to_string());
        }
        let generation = connector.generation;
        let writer = Arc::clone(&connector.writer);
        outbound.pending.insert(
            request_id.clone(),
            PendingSend {
                generation,
                completion: completion_tx,
            },
        );
        (generation, writer)
    };

    let write_result = writer
        .lock()
        .map_err(|_| "WeCom Connector input is unavailable".to_string())
        .and_then(|mut input| {
            input
                .write_all(&encoded)
                .and_then(|_| input.flush())
                .map_err(|error| format!("write WeCom send request failed: {error}"))
        });
    if let Err(error) = write_result {
        cancel_pending_send(shared, generation, &request_id);
        return Err(error);
    }

    wait_for_send_completion(
        shared,
        generation,
        &request_id,
        completion_rx,
        OUTBOUND_SEND_TIMEOUT,
    )?;
    Ok(LocalWecomSendReceipt {
        request_id,
        chat_id,
        sent_at: now_ms(),
    })
}

fn wait_for_send_completion(
    shared: &SupervisorShared,
    generation: u64,
    request_id: &str,
    completion_rx: mpsc::Receiver<Result<(), String>>,
    timeout: Duration,
) -> Result<(), String> {
    match completion_rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            cancel_pending_send(shared, generation, request_id);
            Err("Timed out waiting for WeCom to acknowledge the message".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            cancel_pending_send(shared, generation, request_id);
            Err("WeCom Connector stopped before acknowledging the message".to_string())
        }
    }
}

fn validate_outbound_message(chat_id: String, content: String) -> Result<(String, String), String> {
    let chat_id = chat_id.trim().to_string();
    if chat_id.is_empty() {
        return Err("WeCom chatId is required".to_string());
    }
    if chat_id.chars().count() > OUTBOUND_CHAT_ID_MAX_LEN {
        return Err(format!(
            "WeCom chatId must not exceed {OUTBOUND_CHAT_ID_MAX_LEN} characters"
        ));
    }
    if chat_id.chars().any(char::is_control) {
        return Err("WeCom chatId must not contain control characters".to_string());
    }
    if content.trim().is_empty() {
        return Err("WeCom message content is required".to_string());
    }
    if content.len() > OUTBOUND_CONTENT_MAX_BYTES {
        return Err(format!(
            "WeCom message content must not exceed {OUTBOUND_CONTENT_MAX_BYTES} bytes"
        ));
    }
    Ok((chat_id, content))
}

fn cancel_pending_send(shared: &SupervisorShared, generation: u64, request_id: &str) {
    if let Ok(mut outbound) = shared.outbound.lock() {
        if outbound
            .pending
            .get(request_id)
            .is_some_and(|pending| pending.generation == generation)
        {
            outbound.pending.remove(request_id);
        }
    }
}

fn install_connector_control(
    shared: &Arc<SupervisorShared>,
    writer: ChildStdin,
    ready: Arc<AtomicBool>,
) -> Result<ConnectorControlLifecycle, String> {
    let (generation, stale) = {
        let mut outbound = shared
            .outbound
            .lock()
            .map_err(|_| "WeCom outbound state is unavailable".to_string())?;
        outbound.generation = outbound.generation.wrapping_add(1).max(1);
        let generation = outbound.generation;
        let stale = outbound
            .pending
            .drain()
            .map(|(_, pending)| pending.completion)
            .collect::<Vec<_>>();
        outbound.connector = Some(ActiveConnectorControl {
            generation,
            writer: Arc::new(Mutex::new(writer)),
            ready,
        });
        (generation, stale)
    };
    for completion in stale {
        let _ = completion.send(Err(
            "WeCom Connector restarted before acknowledging the message".to_string(),
        ));
    }
    Ok(ConnectorControlLifecycle {
        shared: Arc::clone(shared),
        generation,
        cleared: false,
    })
}

fn clear_connector_control(shared: &SupervisorShared, generation: u64, reason: &str) {
    let completions = {
        let Ok(mut outbound) = shared.outbound.lock() else {
            return;
        };
        if !outbound
            .connector
            .as_ref()
            .is_some_and(|connector| connector.generation == generation)
        {
            return;
        }
        outbound.connector = None;
        take_pending_for_generation(&mut outbound, generation)
    };
    for completion in completions {
        let _ = completion.send(Err(reason.to_string()));
    }
}

fn take_pending_for_generation(
    outbound: &mut OutboundState,
    generation: u64,
) -> Vec<mpsc::Sender<Result<(), String>>> {
    let request_ids = outbound
        .pending
        .iter()
        .filter_map(|(request_id, pending)| {
            (pending.generation == generation).then(|| request_id.clone())
        })
        .collect::<Vec<_>>();
    request_ids
        .into_iter()
        .filter_map(|request_id| outbound.pending.remove(&request_id))
        .map(|pending| pending.completion)
        .collect()
}

fn handle_connector_control_result(shared: &SupervisorShared, generation: u64, line: &str) -> bool {
    let Some(payload) = line.strip_prefix(CONNECTOR_CONTROL_RESULT_PREFIX) else {
        return false;
    };
    let Ok(result) = serde_json::from_str::<ConnectorSendResult>(payload) else {
        return true;
    };
    let completion = {
        let Ok(mut outbound) = shared.outbound.lock() else {
            return true;
        };
        if outbound.generation != generation {
            return true;
        }
        if !outbound
            .pending
            .get(&result.request_id)
            .is_some_and(|pending| pending.generation == generation)
        {
            return true;
        }
        outbound.pending.remove(&result.request_id)
    };
    if let Some(pending) = completion {
        let outcome = if result.ok {
            Ok(())
        } else {
            Err(sanitize_connector_error(result.error))
        };
        let _ = pending.completion.send(outcome);
    }
    true
}

fn sanitize_connector_error(error: Option<String>) -> String {
    let error = error.unwrap_or_else(|| "WeCom rejected the message".to_string());
    let normalized = error
        .chars()
        .map(|character| {
            if character == '\n' || character == '\r' || character == '\t' {
                ' '
            } else {
                character
            }
        })
        .take(512)
        .collect::<String>();
    let normalized = normalized.trim();
    if normalized.is_empty() {
        "WeCom rejected the message".to_string()
    } else {
        normalized.to_string()
    }
}

fn generate_runtime_token(purpose: &str) -> String {
    format!(
        "arcforge_{purpose}_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

#[derive(Debug)]
struct RestartBackoff {
    failures: u32,
    next_attempt: Instant,
}

impl RestartBackoff {
    fn ready() -> Self {
        Self {
            failures: 0,
            next_attempt: Instant::now(),
        }
    }

    fn reset(&mut self) {
        self.failures = 0;
        self.next_attempt = Instant::now();
    }

    fn fail(&mut self) -> Duration {
        self.failures = self.failures.saturating_add(1);
        let exponent = self.failures.saturating_sub(1).min(5);
        let delay = Duration::from_secs((1u64 << exponent).min(30));
        self.next_attempt = Instant::now() + delay;
        delay
    }

    fn can_start(&self) -> bool {
        Instant::now() >= self.next_attempt
    }
}

struct RunningChild {
    child: Child,
    started_at: Instant,
    ready: Option<Arc<AtomicBool>>,
    connector_control: Option<ConnectorControlLifecycle>,
}

impl RunningChild {
    fn is_ready(&self) -> bool {
        self.ready
            .as_ref()
            .is_none_or(|ready| ready.load(Ordering::Acquire))
    }

    fn clear_connector_control(&mut self, reason: &str) {
        if let Some(mut lifecycle) = self.connector_control.take() {
            lifecycle.clear(reason);
        }
    }
}

struct ConnectorControlLifecycle {
    shared: Arc<SupervisorShared>,
    generation: u64,
    cleared: bool,
}

impl ConnectorControlLifecycle {
    fn clear(&mut self, reason: &str) {
        if self.cleared {
            return;
        }
        self.cleared = true;
        clear_connector_control(&self.shared, self.generation, reason);
    }
}

impl Drop for ConnectorControlLifecycle {
    fn drop(&mut self) {
        self.clear("WeCom Connector stopped before acknowledging the message");
    }
}

fn worker_loop(
    shared: Arc<SupervisorShared>,
    app_handle: tauri::AppHandle,
    gateway_controller: Arc<GatewayController>,
    agent_token: String,
    channel_token: String,
) {
    let mut ownership_wait_reported = false;
    let _runtime_ownership = loop {
        if shared
            .state
            .lock()
            .map(|state| state.shutdown)
            .unwrap_or(true)
        {
            return;
        }
        match RuntimeOwnershipGuard::try_acquire() {
            Ok(Some(guard)) => break guard,
            Ok(None) => {
                if !ownership_wait_reported {
                    record_error(
                        &shared,
                        &app_handle,
                        "Another ArcForge instance owns the desktop WeCom runtime".to_string(),
                    );
                    ownership_wait_reported = true;
                }
                wait_for_wake(&shared);
            }
            Err(error) => {
                record_error(&shared, &app_handle, error);
                return;
            }
        }
    };
    let child_job = match ChildProcessJob::new() {
        Ok(job) => job,
        Err(error) => {
            record_error(&shared, &app_handle, error);
            return;
        }
    };
    let health_client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(HEALTH_TIMEOUT)
        .build()
        .ok();
    let mut applied_revision = 0u64;
    let mut config: Option<RuntimeConfig> = None;
    let mut gateway: Option<RunningChild> = None;
    let mut connector: Option<RunningChild> = None;
    let mut gateway_healthy = false;
    let mut local_agent_applied = false;
    let mut last_health_check = Instant::now() - HEALTH_INTERVAL;
    let mut health_failures = 0u32;
    let mut gateway_backoff = RestartBackoff::ready();
    let mut connector_backoff = RestartBackoff::ready();
    let mut gateway_started_once = false;
    let mut connector_started_once = false;

    loop {
        let (shutdown, revision, restart, desired) = match shared.state.lock() {
            Ok(mut state) => {
                let restart = state.restart_requested;
                state.restart_requested = false;
                (
                    state.shutdown,
                    state.revision,
                    restart,
                    state.desired.clone(),
                )
            }
            Err(_) => break,
        };
        if shutdown {
            break;
        }

        if restart || revision != applied_revision {
            stop_child(&mut connector);
            stop_child(&mut gateway);
            gateway_healthy = false;
            local_agent_applied = false;
            health_failures = 0;
            gateway_backoff.reset();
            connector_backoff.reset();
            config = desired;
            applied_revision = revision;
        }

        let Some(current) = config.as_ref() else {
            wait_for_wake(&shared);
            continue;
        };

        if current.wecom.gateway_mode == WecomGatewayMode::External {
            stop_child(&mut gateway);
            gateway_healthy = false;
            local_agent_applied = false;
            let gateway_status = gateway_controller.status();
            let gateway_ready = gateway_status.online;
            let gateway_state = if gateway_ready {
                "connected"
            } else if gateway_status.enabled && gateway_status.configured {
                "waiting"
            } else {
                "stopped"
            };
            let connector_state = maintain_connector(
                &shared,
                &app_handle,
                current,
                &channel_token,
                &child_job,
                gateway_ready,
                &mut connector,
                &mut connector_backoff,
                &mut connector_started_once,
            );
            let connector_expected = current.connector_should_run();
            let overall = if gateway_ready && (!connector_expected || connector_state == "running")
            {
                "running"
            } else if connector_state == "backoff" {
                "degraded"
            } else if !gateway_status.enabled && !connector_expected {
                "stopped"
            } else {
                "starting"
            };
            if overall == "running" {
                clear_error(&shared, &app_handle);
            }
            publish_status(
                &shared,
                &app_handle,
                StatusUpdate {
                    mode: "external",
                    overall,
                    gateway_state,
                    connector_state,
                    gateway_url: None,
                    gateway_pid: None,
                    connector_pid: connector.as_ref().map(|child| child.child.id()),
                    last_error: None,
                },
            );
            wait_for_wake(&shared);
            continue;
        }

        let local_url = current.local_gateway_url();
        if let Some(running) = gateway.as_mut() {
            match running.child.try_wait() {
                Ok(Some(status)) => {
                    let stable = running.started_at.elapsed() >= PROCESS_STABLE_AFTER;
                    gateway = None;
                    gateway_healthy = false;
                    local_agent_applied = false;
                    stop_child(&mut connector);
                    if stable {
                        gateway_backoff.reset();
                    }
                    let delay = gateway_backoff.fail();
                    record_error(
                        &shared,
                        &app_handle,
                        format!(
                            "Local Gateway exited with {status}; restarting in {}s",
                            delay.as_secs()
                        ),
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    record_error(
                        &shared,
                        &app_handle,
                        format!("Local Gateway status check failed: {error}"),
                    );
                    stop_child(&mut gateway);
                    gateway_healthy = false;
                    local_agent_applied = false;
                    stop_child(&mut connector);
                    gateway_backoff.fail();
                }
            }
        }

        if gateway.is_none() && gateway_backoff.can_start() {
            match spawn_gateway(
                current,
                &agent_token,
                &channel_token,
                Arc::clone(&shared),
                &child_job,
            ) {
                Ok(child) => {
                    mark_process_started(&shared, true, gateway_started_once);
                    gateway_started_once = true;
                    gateway = Some(child);
                    gateway_healthy = false;
                    local_agent_applied = false;
                    last_health_check = Instant::now() - HEALTH_INTERVAL;
                    health_failures = 0;
                }
                Err(error) => {
                    let delay = gateway_backoff.fail();
                    record_error(
                        &shared,
                        &app_handle,
                        format!("{error}; retrying Local Gateway in {}s", delay.as_secs()),
                    );
                }
            }
        }

        if let Some(running) = gateway.as_mut() {
            if last_health_check.elapsed() >= HEALTH_INTERVAL {
                last_health_check = Instant::now();
                let healthy = health_client
                    .as_ref()
                    .is_some_and(|client| gateway_health(client, &local_url));
                if healthy {
                    health_failures = 0;
                    if !local_agent_applied {
                        match gateway_controller
                            .apply_config(local_remote_config(current, &agent_token))
                        {
                            Ok(()) => {
                                local_agent_applied = true;
                            }
                            Err(error) => record_error(
                                &shared,
                                &app_handle,
                                format!("Connect desktop to Local Gateway failed: {error}"),
                            ),
                        }
                    }
                    gateway_healthy = local_agent_applied && gateway_controller.status().online;
                    if gateway_healthy {
                        clear_error(&shared, &app_handle);
                    } else if running.started_at.elapsed() >= STARTUP_TIMEOUT {
                        record_error(
                            &shared,
                            &app_handle,
                            "Desktop Agent did not authenticate with Local Gateway before the startup timeout"
                                .to_string(),
                        );
                        stop_child(&mut connector);
                        stop_child(&mut gateway);
                        local_agent_applied = false;
                        gateway_backoff.fail();
                    }
                } else {
                    health_failures = health_failures.saturating_add(1);
                    if !gateway_healthy && running.started_at.elapsed() >= STARTUP_TIMEOUT {
                        record_error(
                            &shared,
                            &app_handle,
                            "Local Gateway did not become healthy before the startup timeout"
                                .to_string(),
                        );
                        stop_child(&mut gateway);
                        gateway_backoff.fail();
                    } else if gateway_healthy && health_failures >= HEALTH_FAILURE_LIMIT {
                        record_error(
                            &shared,
                            &app_handle,
                            "Local Gateway health check failed repeatedly".to_string(),
                        );
                        gateway_healthy = false;
                        local_agent_applied = false;
                        stop_child(&mut connector);
                        stop_child(&mut gateway);
                        gateway_backoff.fail();
                    }
                }
            }
        }

        let connector_state = maintain_connector(
            &shared,
            &app_handle,
            current,
            &channel_token,
            &child_job,
            gateway_healthy,
            &mut connector,
            &mut connector_backoff,
            &mut connector_started_once,
        );

        let gateway_state = if gateway.is_none() {
            if gateway_backoff.can_start() {
                "starting"
            } else {
                "backoff"
            }
        } else if gateway_healthy {
            "running"
        } else {
            "starting"
        };
        let connector_expected = current.connector_should_run();
        let overall = if gateway_state == "running"
            && (!connector_expected || connector_state == "running")
        {
            "running"
        } else if gateway_state == "backoff" || connector_state == "backoff" {
            "degraded"
        } else {
            "starting"
        };
        publish_status(
            &shared,
            &app_handle,
            StatusUpdate {
                mode: "local",
                overall,
                gateway_state,
                connector_state,
                gateway_url: Some(local_url),
                gateway_pid: gateway.as_ref().map(|child| child.child.id()),
                connector_pid: connector.as_ref().map(|child| child.child.id()),
                last_error: None,
            },
        );
        wait_for_wake(&shared);
    }

    stop_child(&mut connector);
    stop_child(&mut gateway);
    let _ = gateway_controller.disconnect_runtime();
    publish_status(
        &shared,
        &app_handle,
        StatusUpdate {
            mode: config.as_ref().map_or("external", RuntimeConfig::mode_name),
            overall: "stopped",
            gateway_state: "stopped",
            connector_state: "stopped",
            gateway_url: config.as_ref().and_then(|item| {
                (item.wecom.gateway_mode == WecomGatewayMode::Local)
                    .then(|| item.local_gateway_url())
            }),
            gateway_pid: None,
            connector_pid: None,
            last_error: None,
        },
    );
}

#[allow(clippy::too_many_arguments)]
fn maintain_connector(
    shared: &Arc<SupervisorShared>,
    app_handle: &tauri::AppHandle,
    config: &RuntimeConfig,
    local_channel_token: &str,
    child_job: &ChildProcessJob,
    gateway_ready: bool,
    connector: &mut Option<RunningChild>,
    connector_backoff: &mut RestartBackoff,
    connector_started_once: &mut bool,
) -> &'static str {
    if !config.connector_should_run() {
        stop_child(connector);
        return "stopped";
    }
    if !gateway_ready {
        stop_child(connector);
        return "waiting";
    }

    if let Some(running) = connector.as_mut() {
        match running.child.try_wait() {
            Ok(Some(status)) => {
                let stable = running.started_at.elapsed() >= PROCESS_STABLE_AFTER;
                *connector = None;
                if stable {
                    connector_backoff.reset();
                }
                let delay = connector_backoff.fail();
                record_error(
                    shared,
                    app_handle,
                    format!(
                        "WeCom Connector exited with {status}; restarting in {}s",
                        delay.as_secs()
                    ),
                );
            }
            Ok(None) => {}
            Err(error) => {
                record_error(
                    shared,
                    app_handle,
                    format!("WeCom Connector status check failed: {error}"),
                );
                stop_child(connector);
                connector_backoff.fail();
            }
        }
    }

    if connector.as_ref().is_some_and(|running| {
        !running.is_ready() && running.started_at.elapsed() >= CONNECTOR_STARTUP_TIMEOUT
    }) {
        record_error(
            shared,
            app_handle,
            "WeCom Connector did not authenticate with both Gateway and WeCom before the startup timeout"
                .to_string(),
        );
        stop_child(connector);
        connector_backoff.fail();
    }

    if connector.is_none() && connector_backoff.can_start() {
        match spawn_connector(config, local_channel_token, Arc::clone(shared), child_job) {
            Ok(child) => {
                mark_process_started(shared, false, *connector_started_once);
                *connector_started_once = true;
                *connector = Some(child);
            }
            Err(error) => {
                let delay = connector_backoff.fail();
                record_error(
                    shared,
                    app_handle,
                    format!("{error}; retrying WeCom Connector in {}s", delay.as_secs()),
                );
            }
        }
    }

    if connector.as_ref().is_some_and(RunningChild::is_ready) {
        "running"
    } else if connector.is_some() {
        "starting"
    } else if connector_backoff.can_start() {
        "starting"
    } else {
        "backoff"
    }
}

fn wait_for_wake(shared: &SupervisorShared) {
    if let Ok(state) = shared.state.lock() {
        let _ = shared.wake.wait_timeout(state, LOOP_INTERVAL);
    }
}

struct StatusUpdate<'a> {
    mode: &'a str,
    overall: &'a str,
    gateway_state: &'a str,
    connector_state: &'a str,
    gateway_url: Option<String>,
    gateway_pid: Option<u32>,
    connector_pid: Option<u32>,
    last_error: Option<String>,
}

fn publish_status(
    shared: &SupervisorShared,
    app_handle: &tauri::AppHandle,
    update: StatusUpdate<'_>,
) {
    let next = {
        let Ok(mut state) = shared.state.lock() else {
            return;
        };
        let mut next = state.status.clone();
        next.mode = update.mode.to_string();
        next.overall = update.overall.to_string();
        next.gateway_state = update.gateway_state.to_string();
        next.connector_state = update.connector_state.to_string();
        next.gateway_url = update.gateway_url;
        next.gateway_pid = update.gateway_pid;
        next.connector_pid = update.connector_pid;
        if update.last_error.is_some() {
            next.last_error = update.last_error;
        }
        next.updated_at = state.status.updated_at;
        if next == state.status {
            return;
        }
        next.updated_at = now_ms();
        state.status = next.clone();
        next
    };
    let _ = app_handle.emit(STATUS_EVENT, next);
}

fn record_error(shared: &SupervisorShared, app_handle: &tauri::AppHandle, error: String) {
    let status = if let Ok(mut state) = shared.state.lock() {
        state.status.last_error = Some(redact_text(&error, state.desired.as_ref()));
        state.status.updated_at = now_ms();
        Some(state.status.clone())
    } else {
        None
    };
    if let Some(status) = status {
        let _ = app_handle.emit(STATUS_EVENT, status);
    }
}

fn clear_error(shared: &SupervisorShared, app_handle: &tauri::AppHandle) {
    let status = if let Ok(mut state) = shared.state.lock() {
        if state.status.last_error.is_none() {
            return;
        }
        state.status.last_error = None;
        state.status.updated_at = now_ms();
        Some(state.status.clone())
    } else {
        None
    };
    if let Some(status) = status {
        let _ = app_handle.emit(STATUS_EVENT, status);
    }
}

fn mark_process_started(shared: &SupervisorShared, gateway: bool, is_restart: bool) {
    if let Ok(mut state) = shared.state.lock() {
        if is_restart {
            if gateway {
                state.status.gateway_restart_count =
                    state.status.gateway_restart_count.saturating_add(1);
            } else {
                state.status.connector_restart_count =
                    state.status.connector_restart_count.saturating_add(1);
            }
        }
        state.status.last_error = None;
        state.status.updated_at = now_ms();
    }
}

fn local_remote_config(config: &RuntimeConfig, agent_token: &str) -> RemoteSettingsPayload {
    let mut local = config.remote.clone();
    local.enabled = true;
    local.gateway_url = "http://127.0.0.1".to_string();
    local.grpc_port = config.wecom.local_gateway_port;
    local.grpc_endpoint.clear();
    local.token = agent_token.to_string();
    local.auto_reconnect = true;
    local
}

fn gateway_health(client: &reqwest::blocking::Client, gateway_url: &str) -> bool {
    client
        .get(format!("{}/healthz", gateway_url.trim_end_matches('/')))
        .send()
        .is_ok_and(|response| response.status().is_success())
}

fn spawn_gateway(
    config: &RuntimeConfig,
    agent_token: &str,
    channel_token: &str,
    shared: Arc<SupervisorShared>,
    child_job: &ChildProcessJob,
) -> Result<RunningChild, String> {
    let program = resolve_gateway_program()?;
    let mut command = Command::new(&program.program);
    command
        .args(&program.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env(
            "ARCFORGE_GATEWAY_HTTP_ADDR",
            format!("127.0.0.1:{}", config.wecom.local_gateway_port),
        )
        .env("ARCFORGE_GATEWAY_TOKEN", agent_token)
        .env("ARCFORGE_GATEWAY_CHANNEL_TOKEN", channel_token)
        .env(
            "ARCFORGE_GATEWAY_CHANNEL_TENANT_ID",
            &config.wecom.tenant_id,
        )
        .env("ARCFORGE_GATEWAY_CHANNEL_BOT_ID", &config.wecom.bot_id)
        .env(
            "ARCFORGE_GATEWAY_CHANNEL_CONNECTOR_ID",
            &config.wecom.connector_id,
        )
        .env(
            "ARCFORGE_GATEWAY_CHANNEL_ALLOW_GROUP_MESSAGES",
            bool_env(config.wecom.allow_group_messages),
        )
        .env_remove("ARCFORGE_GATEWAY_TLS_CERT")
        .env_remove("ARCFORGE_GATEWAY_TLS_KEY")
        .env_remove("LIVEAGENT_GATEWAY_TLS_CERT")
        .env_remove("LIVEAGENT_GATEWAY_TLS_KEY");
    if let Some(current_dir) = &program.current_dir {
        command.current_dir(current_dir);
    }
    configure_managed_child(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("start Local Gateway ({}) failed: {error}", program.label))?;
    if let Err(error) = child_job.assign(&child) {
        kill_child_process_tree_best_effort(&mut child);
        return Err(error);
    }
    if let Err(error) = resume_managed_child(&child) {
        kill_child_process_tree_best_effort(&mut child);
        return Err(error);
    }
    attach_log_readers(
        &mut child,
        ProcessKind::Gateway,
        shared,
        vec![agent_token.to_string(), channel_token.to_string()],
        None,
        None,
    );
    Ok(RunningChild {
        child,
        started_at: Instant::now(),
        ready: None,
        connector_control: None,
    })
}

fn spawn_connector(
    config: &RuntimeConfig,
    local_channel_token: &str,
    shared: Arc<SupervisorShared>,
    child_job: &ChildProcessJob,
) -> Result<RunningChild, String> {
    let program = resolve_connector_program()?;
    let (gateway_url, channel_token) = match config.wecom.gateway_mode {
        WecomGatewayMode::Local => (config.local_gateway_url(), local_channel_token),
        WecomGatewayMode::External => (
            crate::services::gateway::build_ws_url(
                &config.remote.gateway_url,
                config.remote.grpc_port,
                "/ws/v2/channel",
            )?,
            config.wecom.channel_token.as_str(),
        ),
    };
    let mut command = Command::new(&program.program);
    command
        .args(&program.arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("WECOM_AIBOT_BOT_ID", &config.wecom.bot_id)
        .env("WECOM_AIBOT_SECRET", &config.wecom.secret)
        .env("ARCFORGE_GATEWAY_URL", &gateway_url)
        .env("ARCFORGE_GATEWAY_CHANNEL_URL", &gateway_url)
        .env("ARCFORGE_GATEWAY_CHANNEL_TOKEN", channel_token)
        .env(
            "ARCFORGE_GATEWAY_CHANNEL_TENANT_ID",
            &config.wecom.tenant_id,
        )
        .env(
            "ARCFORGE_GATEWAY_CHANNEL_CONNECTOR_ID",
            &config.wecom.connector_id,
        )
        .env(
            "ARCFORGE_GATEWAY_CHANNEL_ALLOW_GROUP_MESSAGES",
            bool_env(config.wecom.allow_group_messages),
        );
    if let Some(current_dir) = &program.current_dir {
        command.current_dir(current_dir);
    }
    configure_managed_child(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("start WeCom Connector ({}) failed: {error}", program.label))?;
    if let Err(error) = child_job.assign(&child) {
        kill_child_process_tree_best_effort(&mut child);
        return Err(error);
    }
    if let Err(error) = resume_managed_child(&child) {
        kill_child_process_tree_best_effort(&mut child);
        return Err(error);
    }
    let stdin = child.stdin.take().ok_or_else(|| {
        kill_child_process_tree_best_effort(&mut child);
        "WeCom Connector stdin pipe is unavailable".to_string()
    })?;
    let ready = Arc::new(AtomicBool::new(false));
    let connector_control = match install_connector_control(&shared, stdin, Arc::clone(&ready)) {
        Ok(control) => control,
        Err(error) => {
            kill_child_process_tree_best_effort(&mut child);
            return Err(error);
        }
    };
    let control_generation = connector_control.generation;
    attach_log_readers(
        &mut child,
        ProcessKind::Connector,
        shared,
        vec![config.wecom.secret.clone(), channel_token.to_string()],
        Some((CONNECTOR_READY_MARKER, Arc::clone(&ready))),
        Some(control_generation),
    );
    Ok(RunningChild {
        child,
        started_at: Instant::now(),
        ready: Some(ready),
        connector_control: Some(connector_control),
    })
}

fn bool_env(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn stop_child(child: &mut Option<RunningChild>) {
    if let Some(mut running) = child.take() {
        running.clear_connector_control("WeCom Connector stopped before acknowledging the message");
        if terminate_child_process_tree(&mut running.child, SHUTDOWN_GRACE).is_err() {
            kill_child_process_tree_best_effort(&mut running.child);
        }
    }
}

#[derive(Clone, Copy)]
enum ProcessKind {
    Gateway,
    Connector,
}

fn attach_log_readers(
    child: &mut Child,
    kind: ProcessKind,
    shared: Arc<SupervisorShared>,
    secrets: Vec<String>,
    readiness: Option<(&'static str, Arc<AtomicBool>)>,
    control_generation: Option<u64>,
) {
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(
            stdout,
            kind,
            "stdout",
            Arc::clone(&shared),
            secrets.clone(),
            readiness.clone(),
            control_generation,
        );
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(
            stderr,
            kind,
            "stderr",
            shared,
            secrets,
            readiness,
            control_generation,
        );
    }
}

fn spawn_log_reader<R>(
    reader: R,
    kind: ProcessKind,
    stream: &'static str,
    shared: Arc<SupervisorShared>,
    secrets: Vec<String>,
    readiness: Option<(&'static str, Arc<AtomicBool>)>,
    control_generation: Option<u64>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if let Some((marker, ready)) = readiness.as_ref() {
                if line.trim() == *marker {
                    ready.store(true, Ordering::Release);
                    continue;
                }
            }
            if control_generation.is_some_and(|generation| {
                handle_connector_control_result(&shared, generation, &line)
            }) {
                continue;
            }
            let mut redacted = line;
            for secret in &secrets {
                if !secret.is_empty() {
                    redacted = redacted.replace(secret, "[redacted]");
                }
            }
            let stamped = format!("{} {stream}: {redacted}", now_ms());
            if let Ok(mut state) = shared.state.lock() {
                match kind {
                    ProcessKind::Gateway => state.gateway_log.push(stamped),
                    ProcessKind::Connector => state.connector_log.push(stamped),
                }
            }
        }
    });
}

fn redact_text(value: &str, config: Option<&RuntimeConfig>) -> String {
    let Some(config) = config else {
        return value.to_string();
    };
    let mut redacted = value.to_string();
    for secret in [&config.wecom.secret, &config.wecom.channel_token] {
        if !secret.is_empty() {
            redacted = redacted.replace(secret, "[redacted]");
        }
    }
    redacted
}

struct RuntimeProgram {
    program: PathBuf,
    arguments: Vec<OsString>,
    current_dir: Option<PathBuf>,
    label: &'static str,
}

fn resolve_gateway_program() -> Result<RuntimeProgram, String> {
    resolve_program(
        "ARCFORGE_GATEWAY_SIDECAR_PATH",
        GATEWAY_SIDECAR_STEM,
        || {
            let gateway_root = repository_root()?.join("crates").join("agent-gateway");
            if !gateway_root.is_dir() {
                return Err("Local Gateway source directory was not found".to_string());
            }
            Ok(RuntimeProgram {
                program: std::env::var_os("ARCFORGE_GATEWAY_GO")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("go")),
                arguments: vec![OsString::from("run"), OsString::from("./cmd/gateway")],
                current_dir: Some(gateway_root),
                label: "development-go-fallback",
            })
        },
    )
}

fn resolve_connector_program() -> Result<RuntimeProgram, String> {
    resolve_program(
        "ARCFORGE_WECOM_CONNECTOR_PATH",
        CONNECTOR_SIDECAR_STEM,
        || {
            let root = repository_root()?;
            if !root.join("connectors").join("wecom_aibot").is_dir() {
                return Err("WeCom Connector source directory was not found".to_string());
            }
            Ok(RuntimeProgram {
                program: std::env::var_os("ARCFORGE_WECOM_CONNECTOR_PYTHON")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("python")),
                arguments: vec![
                    OsString::from("-m"),
                    OsString::from("connectors.wecom_aibot.worker"),
                ],
                current_dir: Some(root),
                label: "development-python-fallback",
            })
        },
    )
}

fn resolve_program<F>(
    override_env: &str,
    stem: &str,
    debug_fallback: F,
) -> Result<RuntimeProgram, String>
where
    F: FnOnce() -> Result<RuntimeProgram, String>,
{
    if let Some(path) = std::env::var_os(override_env) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(RuntimeProgram {
                program: path,
                arguments: Vec::new(),
                current_dir: None,
                label: "path-override",
            });
        }
        return Err(format!("{override_env} must identify an executable file"));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(directory) = current_exe.parent() {
            let bundled = directory.join(platform_executable_name(stem));
            if bundled.is_file() {
                return Ok(RuntimeProgram {
                    program: bundled,
                    arguments: Vec::new(),
                    current_dir: None,
                    label: "bundled-sidecar",
                });
            }
        }
    }

    let development = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{stem}-{}", target_sidecar_suffix()));
    if development.is_file() {
        return Ok(RuntimeProgram {
            program: development,
            arguments: Vec::new(),
            current_dir: None,
            label: "development-sidecar",
        });
    }

    if cfg!(debug_assertions)
        || std::env::var("ARCFORGE_WECOM_ALLOW_SOURCE_FALLBACK").is_ok_and(|value| value == "1")
    {
        return debug_fallback();
    }

    Err(format!(
        "Bundled {stem} sidecar is unavailable; rebuild the desktop sidecars"
    ))
}

fn platform_executable_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn target_sidecar_suffix() -> &'static str {
    "x86_64-pc-windows-msvc.exe"
}

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
fn target_sidecar_suffix() -> &'static str {
    "aarch64-pc-windows-msvc.exe"
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn target_sidecar_suffix() -> &'static str {
    "x86_64-apple-darwin"
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn target_sidecar_suffix() -> &'static str {
    "aarch64-apple-darwin"
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn target_sidecar_suffix() -> &'static str {
    "x86_64-unknown-linux-gnu"
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn target_sidecar_suffix() -> &'static str {
    "aarch64-unknown-linux-gnu"
}

fn repository_root() -> Result<PathBuf, String> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "ArcForge repository root could not be resolved".to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_shared() -> SupervisorShared {
        SupervisorShared {
            state: Mutex::new(SharedState::default()),
            outbound: Mutex::new(OutboundState::default()),
            wake: Condvar::new(),
        }
    }

    #[test]
    fn runtime_tokens_are_distinct_and_purpose_scoped() {
        let agent = generate_runtime_token("agent");
        let channel = generate_runtime_token("channel");
        assert_ne!(agent, channel);
        assert!(agent.starts_with("arcforge_agent_"));
        assert!(channel.starts_with("arcforge_channel_"));
    }

    #[test]
    fn restart_backoff_is_bounded() {
        let mut backoff = RestartBackoff::ready();
        let mut delays = Vec::new();
        for _ in 0..8 {
            delays.push(backoff.fail().as_secs());
        }
        assert_eq!(delays, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn public_status_uses_frontend_contract_without_credentials() {
        let status = LocalWecomStatus {
            mode: "local".to_string(),
            gateway_url: Some("http://127.0.0.1:18780".to_string()),
            gateway_restart_count: 2,
            connector_restart_count: 3,
            ..LocalWecomStatus::default()
        };
        let value = serde_json::to_value(status).expect("serialize status");
        assert_eq!(value["localGatewayUrl"], "http://127.0.0.1:18780");
        assert_eq!(value["gatewayRestarts"], 2);
        assert_eq!(value["connectorRestarts"], 3);
        assert!(value.get("agentToken").is_none());
        assert!(value.get("channelToken").is_none());
        assert!(value.get("secret").is_none());
    }

    #[test]
    fn outbound_request_uses_versioned_camel_case_contract() {
        let request = ConnectorSendRequest {
            v: 1,
            kind: "send_markdown",
            request_id: "request-1",
            chat_id: "user-1",
            content: "hello",
        };
        let value = serde_json::to_value(request).expect("serialize outbound request");
        assert_eq!(
            value,
            serde_json::json!({
                "v": 1,
                "type": "send_markdown",
                "requestId": "request-1",
                "chatId": "user-1",
                "content": "hello",
            })
        );
    }

    #[test]
    fn control_result_completes_only_the_matching_generation() {
        let shared = test_shared();
        let (completion, receiver) = mpsc::channel();
        {
            let mut outbound = shared.outbound.lock().expect("lock outbound state");
            outbound.generation = 7;
            outbound.pending.insert(
                "request-1".to_string(),
                PendingSend {
                    generation: 7,
                    completion,
                },
            );
        }
        let stale_line = format!(
            "{CONNECTOR_CONTROL_RESULT_PREFIX}{}",
            r#"{"requestId":"request-1","ok":true,"error":""}"#
        );
        assert!(handle_connector_control_result(&shared, 6, &stale_line));
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        assert!(handle_connector_control_result(&shared, 7, &stale_line));
        assert_eq!(receiver.recv_timeout(Duration::from_millis(50)), Ok(Ok(())));
        assert!(shared
            .outbound
            .lock()
            .expect("lock outbound state")
            .pending
            .is_empty());
    }

    #[test]
    fn connector_error_is_correlated_and_sanitized() {
        let shared = test_shared();
        let (completion, receiver) = mpsc::channel();
        {
            let mut outbound = shared.outbound.lock().expect("lock outbound state");
            outbound.generation = 3;
            outbound.pending.insert(
                "request-2".to_string(),
                PendingSend {
                    generation: 3,
                    completion,
                },
            );
        }
        let line = format!(
            "{CONNECTOR_CONTROL_RESULT_PREFIX}{}",
            r#"{"requestId":"request-2","ok":false,"error":"send_failed\nretry"}"#
        );
        assert!(handle_connector_control_result(&shared, 3, &line));
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(50)),
            Ok(Err("send_failed retry".to_string()))
        );
    }

    #[test]
    fn restart_cleanup_drains_only_its_generation() {
        let mut outbound = OutboundState::default();
        let (old_completion, old_receiver) = mpsc::channel();
        let (current_completion, current_receiver) = mpsc::channel();
        outbound.pending.insert(
            "old".to_string(),
            PendingSend {
                generation: 4,
                completion: old_completion,
            },
        );
        outbound.pending.insert(
            "current".to_string(),
            PendingSend {
                generation: 5,
                completion: current_completion,
            },
        );

        let completions = take_pending_for_generation(&mut outbound, 4);
        for completion in completions {
            let _ = completion.send(Err("connector restarted".to_string()));
        }
        assert_eq!(
            old_receiver.recv_timeout(Duration::from_millis(50)),
            Ok(Err("connector restarted".to_string()))
        );
        assert!(matches!(
            current_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(outbound.pending.contains_key("current"));
    }

    #[test]
    fn outbound_timeout_removes_the_pending_request() {
        let shared = test_shared();
        let (completion, receiver) = mpsc::channel();
        {
            let mut outbound = shared.outbound.lock().expect("lock outbound state");
            outbound.pending.insert(
                "request-timeout".to_string(),
                PendingSend {
                    generation: 9,
                    completion,
                },
            );
        }
        let error = wait_for_send_completion(
            &shared,
            9,
            "request-timeout",
            receiver,
            Duration::from_millis(1),
        )
        .expect_err("request should time out");
        assert!(error.contains("Timed out"));
        assert!(shared
            .outbound
            .lock()
            .expect("lock outbound state")
            .pending
            .is_empty());
    }

    #[test]
    fn outbound_validation_rejects_unsafe_or_empty_input() {
        assert!(validate_outbound_message("  ".to_string(), "hello".to_string()).is_err());
        assert!(validate_outbound_message("user\n2".to_string(), "hello".to_string()).is_err());
        assert!(validate_outbound_message("user".to_string(), " \n ".to_string()).is_err());
        let (chat_id, content) =
            validate_outbound_message(" user-1 ".to_string(), "hello".to_string())
                .expect("valid outbound message");
        assert_eq!(chat_id, "user-1");
        assert_eq!(content, "hello");
    }

    #[test]
    fn send_receipt_uses_camel_case_public_contract() {
        let value = serde_json::to_value(LocalWecomSendReceipt {
            request_id: "request-3".to_string(),
            chat_id: "user-3".to_string(),
            sent_at: 123,
        })
        .expect("serialize receipt");
        assert_eq!(value["requestId"], "request-3");
        assert_eq!(value["chatId"], "user-3");
        assert_eq!(value["sentAt"], 123);
    }
}
