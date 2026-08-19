//! Desktop-side ledger of chat-run lifecycle states destined for the gateway.
//!
//! Terminal signals ("completed"/"failed"/"cancelled") must reach the gateway
//! at least once; otherwise the WebUI shows a run as streaming forever. The
//! ledger records every run the desktop knows about and keeps unsent terminal
//! states around so callers can retransmit them until an acknowledged send.
//!
//! Pure std container (no tauri/tokio) so it stays unit-testable.

use std::collections::HashMap;
use std::time::{Duration, Instant};

const DEFAULT_ACTIVE_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_TERMINAL_RETENTION: Duration = Duration::from_secs(10 * 60);
const DEFAULT_TERMINAL_CAP: usize = 32;

pub const DESKTOP_RUN_LOST_ERROR_CODE: &str = "desktop_run_lost";
pub const DESKTOP_RUN_LOST_MESSAGE: &str = "The desktop runtime stopped reporting this run.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRunLedgerState {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl ChatRunLedgerState {
    // These strings are the gateway's run-state vocabulary; do not change them.
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatRunLedgerState::Running => "running",
            ChatRunLedgerState::Completed => "completed",
            ChatRunLedgerState::Failed => "failed",
            ChatRunLedgerState::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(&self) -> bool {
        !matches!(self, ChatRunLedgerState::Running)
    }
}

#[derive(Debug, Clone)]
pub struct ChatRunLedgerEntry {
    pub run_id: String,
    pub conversation_id: String,
    pub state: ChatRunLedgerState,
    pub error_code: String,
    pub message: String,
    pub terminal_sent: bool,
    // Liveness while Running; frozen at terminal time afterwards (touch is a
    // no-op on terminal entries), so it doubles as the retention clock.
    pub touched_at: Instant,
    pub updated_at_ms: i64,
}

pub struct ChatRunLedger {
    entries: HashMap<String, ChatRunLedgerEntry>,
    active_ttl: Duration,
    terminal_retention: Duration,
    terminal_cap: usize,
}

impl Default for ChatRunLedger {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatRunLedger {
    pub fn new() -> Self {
        Self::with_tunables(
            DEFAULT_ACTIVE_TTL,
            DEFAULT_TERMINAL_RETENTION,
            DEFAULT_TERMINAL_CAP,
        )
    }

    pub fn with_tunables(
        active_ttl: Duration,
        terminal_retention: Duration,
        terminal_cap: usize,
    ) -> Self {
        Self {
            entries: HashMap::new(),
            active_ttl,
            terminal_retention,
            terminal_cap,
        }
    }

    pub fn mark_running(
        &mut self,
        run_id: &str,
        conversation_id: &str,
        now: Instant,
        now_ms: i64,
    ) -> bool {
        let run_id = run_id.trim();
        if run_id.is_empty() {
            return false;
        }
        if let Some(entry) = self.entries.get_mut(run_id) {
            if entry.state.is_terminal() {
                return false;
            }
            entry.state = ChatRunLedgerState::Running;
            entry.touched_at = now;
            entry.updated_at_ms = now_ms;
            Self::fill_conversation_id(entry, conversation_id);
            return true;
        }
        self.entries.insert(
            run_id.to_string(),
            Self::running_entry(run_id, conversation_id, now, now_ms),
        );
        true
    }

    pub fn touch(&mut self, run_id: &str, conversation_id: &str, now: Instant, now_ms: i64) {
        let run_id = run_id.trim();
        if run_id.is_empty() {
            return;
        }
        if let Some(entry) = self.entries.get_mut(run_id) {
            if entry.state.is_terminal() {
                return;
            }
            entry.touched_at = now;
            entry.updated_at_ms = now_ms;
            Self::fill_conversation_id(entry, conversation_id);
            return;
        }
        // Refresh-only when no conversation is known: a heartbeat for a run
        // that never started (or whose entry was evicted) must not seed a
        // phantom entry the gateway can never resolve to a conversation.
        if conversation_id.trim().is_empty() {
            return;
        }
        self.entries.insert(
            run_id.to_string(),
            Self::running_entry(run_id, conversation_id, now, now_ms),
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_terminal(
        &mut self,
        run_id: &str,
        conversation_id: &str,
        state: ChatRunLedgerState,
        error_code: &str,
        message: &str,
        now: Instant,
        now_ms: i64,
    ) -> bool {
        let run_id = run_id.trim();
        if run_id.is_empty() || !state.is_terminal() {
            return false;
        }
        if let Some(entry) = self.entries.get_mut(run_id) {
            // First terminal wins: a later, conflicting terminal must not
            // overwrite the state that already represents the run outcome.
            if entry.state.is_terminal() {
                if entry.state != state {
                    return false;
                }

                // A runtime snapshot can race the richer done/error event and
                // record the same terminal state without its user-facing
                // payload. Permit that payload to fill previously empty slots,
                // while keeping non-empty first-terminal data immutable.
                let mut enriched = false;
                if entry.error_code.trim().is_empty() && !error_code.trim().is_empty() {
                    entry.error_code = error_code.to_string();
                    enriched = true;
                }
                if entry.message.trim().is_empty() && !message.trim().is_empty() {
                    entry.message = message.to_string();
                    enriched = true;
                }
                if entry.conversation_id.is_empty() && !conversation_id.trim().is_empty() {
                    entry.conversation_id = conversation_id.trim().to_string();
                    enriched = true;
                }
                if enriched {
                    entry.terminal_sent = false;
                    entry.touched_at = now;
                    entry.updated_at_ms = now_ms;
                }
                return enriched;
            }
            entry.state = state;
            entry.error_code = error_code.to_string();
            entry.message = message.to_string();
            entry.terminal_sent = false;
            entry.touched_at = now;
            entry.updated_at_ms = now_ms;
            Self::fill_conversation_id(entry, conversation_id);
            return true;
        }
        self.entries.insert(
            run_id.to_string(),
            ChatRunLedgerEntry {
                run_id: run_id.to_string(),
                conversation_id: conversation_id.trim().to_string(),
                state,
                error_code: error_code.to_string(),
                message: message.to_string(),
                terminal_sent: false,
                touched_at: now,
                updated_at_ms: now_ms,
            },
        );
        true
    }

    pub fn get(&self, run_id: &str) -> Option<&ChatRunLedgerEntry> {
        self.entries.get(run_id.trim())
    }

    pub fn mark_terminal_sent(&mut self, run_id: &str) {
        if let Some(entry) = self.entries.get_mut(run_id.trim()) {
            if entry.state.is_terminal() {
                entry.terminal_sent = true;
            }
        }
    }

    pub fn unsent_terminals(&self) -> Vec<ChatRunLedgerEntry> {
        let mut unsent: Vec<ChatRunLedgerEntry> = self
            .entries
            .values()
            .filter(|entry| entry.state.is_terminal() && !entry.terminal_sent)
            .cloned()
            .collect();
        unsent.sort_by(|a, b| {
            a.updated_at_ms
                .cmp(&b.updated_at_ms)
                .then_with(|| a.run_id.cmp(&b.run_id))
        });
        unsent
    }

    pub fn active_reports(&self, now: Instant) -> Vec<ChatRunLedgerEntry> {
        let mut active: Vec<ChatRunLedgerEntry> = self
            .entries
            .values()
            .filter(|entry| {
                !entry.state.is_terminal()
                    && now.saturating_duration_since(entry.touched_at) <= self.active_ttl
            })
            .cloned()
            .collect();
        active.sort_by(|a, b| {
            a.updated_at_ms
                .cmp(&b.updated_at_ms)
                .then_with(|| a.run_id.cmp(&b.run_id))
        });
        active
    }

    pub fn recent_terminal_reports(&self) -> Vec<ChatRunLedgerEntry> {
        // Entries past the retention window are removed by `sweep`, so
        // everything terminal that is still here is recent enough to report.
        let mut recent: Vec<ChatRunLedgerEntry> = self
            .entries
            .values()
            .filter(|entry| entry.state.is_terminal())
            .cloned()
            .collect();
        recent.sort_by(|a, b| {
            b.updated_at_ms
                .cmp(&a.updated_at_ms)
                .then_with(|| a.run_id.cmp(&b.run_id))
        });
        recent.truncate(self.terminal_cap);
        recent
    }

    pub fn sweep(&mut self, now: Instant, now_ms: i64) -> Vec<ChatRunLedgerEntry> {
        let mut demoted: Vec<ChatRunLedgerEntry> = Vec::new();
        for entry in self.entries.values_mut() {
            if entry.state.is_terminal() {
                continue;
            }
            if now.saturating_duration_since(entry.touched_at) <= self.active_ttl {
                continue;
            }
            entry.state = ChatRunLedgerState::Failed;
            entry.error_code = DESKTOP_RUN_LOST_ERROR_CODE.to_string();
            entry.message = DESKTOP_RUN_LOST_MESSAGE.to_string();
            entry.terminal_sent = false;
            entry.touched_at = now;
            entry.updated_at_ms = now_ms;
            demoted.push(entry.clone());
        }

        let terminal_retention = self.terminal_retention;
        // Unsent terminals are kept past the normal retention so they keep
        // retrying, but 3x retention bounds the leak if sends never succeed.
        let unsent_retention = terminal_retention.saturating_mul(3);
        self.entries.retain(|_, entry| {
            if !entry.state.is_terminal() {
                return true;
            }
            let age = now.saturating_duration_since(entry.touched_at);
            if entry.terminal_sent {
                age <= terminal_retention
            } else {
                age <= unsent_retention
            }
        });

        demoted
    }

    fn running_entry(
        run_id: &str,
        conversation_id: &str,
        now: Instant,
        now_ms: i64,
    ) -> ChatRunLedgerEntry {
        ChatRunLedgerEntry {
            run_id: run_id.trim().to_string(),
            conversation_id: conversation_id.trim().to_string(),
            state: ChatRunLedgerState::Running,
            error_code: String::new(),
            message: String::new(),
            terminal_sent: false,
            touched_at: now,
            updated_at_ms: now_ms,
        }
    }

    fn fill_conversation_id(entry: &mut ChatRunLedgerEntry, conversation_id: &str) {
        let conversation_id = conversation_id.trim();
        if entry.conversation_id.is_empty() && !conversation_id.is_empty() {
            entry.conversation_id = conversation_id.to_string();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ledger() -> ChatRunLedger {
        ChatRunLedger::with_tunables(Duration::from_secs(300), Duration::from_secs(600), 4)
    }

    #[test]
    fn first_terminal_wins() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        assert!(ledger.mark_running("run-1", "conversation-1", t0, 1_000));
        assert!(ledger.mark_terminal(
            "run-1",
            "conversation-1",
            ChatRunLedgerState::Completed,
            "",
            "",
            t0 + Duration::from_secs(1),
            2_000,
        ));
        assert!(!ledger.mark_terminal(
            "run-1",
            "conversation-1",
            ChatRunLedgerState::Failed,
            "late_error",
            "should not overwrite",
            t0 + Duration::from_secs(2),
            3_000,
        ));
        assert!(!ledger.mark_running(
            "run-1",
            "conversation-1",
            t0 + Duration::from_secs(3),
            4_000
        ));

        let entries = ledger.unsent_terminals();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, ChatRunLedgerState::Completed);
        assert_eq!(entries[0].error_code, "");
        assert_eq!(entries[0].updated_at_ms, 2_000);
    }

    #[test]
    fn touch_without_conversation_never_seeds_an_entry() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        // A claim-time heartbeat may fire before the run is marked running;
        // it must not create a phantom entry with no conversation binding.
        ledger.touch("run-1", "", t0, 1_000);
        assert!(ledger.active_reports(t0).is_empty());

        // Once the run exists, an id-less touch still refreshes liveness.
        ledger.mark_running("run-1", "conversation-1", t0, 1_000);
        ledger.touch("run-1", "", t0 + Duration::from_secs(299), 2_000);
        assert_eq!(
            ledger.active_reports(t0 + Duration::from_secs(400)).len(),
            1
        );
    }

    #[test]
    fn same_terminal_can_enrich_empty_payload_without_overwriting_first_content() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        assert!(ledger.mark_terminal("run-1", "", ChatRunLedgerState::Failed, "", "", t0, 1_000,));
        ledger.mark_terminal_sent("run-1");

        assert!(ledger.mark_terminal(
            "run-1",
            "conversation-1",
            ChatRunLedgerState::Failed,
            "runtime_error",
            "request failed",
            t0 + Duration::from_secs(1),
            2_000,
        ));
        let enriched = ledger.unsent_terminals();
        assert_eq!(enriched.len(), 1);
        assert_eq!(enriched[0].conversation_id, "conversation-1");
        assert_eq!(enriched[0].error_code, "runtime_error");
        assert_eq!(enriched[0].message, "request failed");
        assert_eq!(enriched[0].updated_at_ms, 2_000);

        ledger.mark_terminal_sent("run-1");
        assert!(!ledger.mark_terminal(
            "run-1",
            "conversation-1",
            ChatRunLedgerState::Failed,
            "replacement_error",
            "replacement message",
            t0 + Duration::from_secs(2),
            3_000,
        ));
        assert!(!ledger.mark_terminal(
            "run-1",
            "conversation-1",
            ChatRunLedgerState::Completed,
            "",
            "conflicting completion",
            t0 + Duration::from_secs(3),
            4_000,
        ));
        assert!(ledger.unsent_terminals().is_empty());
        let entry = ledger.get("run-1").expect("terminal entry");
        assert_eq!(entry.state, ChatRunLedgerState::Failed);
        assert_eq!(entry.error_code, "runtime_error");
        assert_eq!(entry.message, "request failed");
        assert_eq!(entry.updated_at_ms, 2_000);
    }

    #[test]
    fn touch_after_terminal_is_noop() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        assert!(ledger.mark_terminal(
            "run-1",
            "conversation-1",
            ChatRunLedgerState::Cancelled,
            "",
            "",
            t0,
            1_000,
        ));
        ledger.touch(
            "run-1",
            "conversation-1",
            t0 + Duration::from_secs(5),
            2_000,
        );

        let entries = ledger.recent_terminal_reports();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, ChatRunLedgerState::Cancelled);
        assert_eq!(entries[0].updated_at_ms, 1_000);
        assert!(ledger
            .active_reports(t0 + Duration::from_secs(5))
            .is_empty());
    }

    #[test]
    fn unsent_terminals_clear_after_mark_terminal_sent() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        ledger.mark_running("run-1", "conversation-1", t0, 1_000);
        ledger.mark_terminal(
            "run-1",
            "conversation-1",
            ChatRunLedgerState::Failed,
            "boom",
            "run failed",
            t0 + Duration::from_secs(1),
            2_000,
        );

        let unsent = ledger.unsent_terminals();
        assert_eq!(unsent.len(), 1);
        assert_eq!(unsent[0].run_id, "run-1");
        assert_eq!(unsent[0].error_code, "boom");
        assert_eq!(unsent[0].message, "run failed");

        ledger.mark_terminal_sent("run-1");
        assert!(ledger.unsent_terminals().is_empty());

        // A duplicate terminal for an already-terminal run must not reset
        // terminal_sent and re-trigger retransmission.
        assert!(!ledger.mark_terminal(
            "run-1",
            "conversation-1",
            ChatRunLedgerState::Failed,
            "boom",
            "run failed",
            t0 + Duration::from_secs(2),
            3_000,
        ));
        assert!(ledger.unsent_terminals().is_empty());
    }

    #[test]
    fn ttl_demotion_returns_demoted_entries_once() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        ledger.mark_running("run-1", "conversation-1", t0, 1_000);

        let stale = t0 + Duration::from_secs(301);
        let demoted = ledger.sweep(stale, 2_000);
        assert_eq!(demoted.len(), 1);
        assert_eq!(demoted[0].run_id, "run-1");
        assert_eq!(demoted[0].state, ChatRunLedgerState::Failed);
        assert_eq!(demoted[0].error_code, DESKTOP_RUN_LOST_ERROR_CODE);
        assert_eq!(demoted[0].message, DESKTOP_RUN_LOST_MESSAGE);
        assert!(!demoted[0].terminal_sent);

        // Demoted entries are terminal now and show up for retransmission.
        assert_eq!(ledger.unsent_terminals().len(), 1);
        // A later sweep must not demote (or return) them again.
        assert!(ledger
            .sweep(stale + Duration::from_secs(1), 3_000)
            .is_empty());
        assert_eq!(ledger.unsent_terminals().len(), 1);
    }

    #[test]
    fn sweep_keeps_fresh_running_entries() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        ledger.mark_running("run-1", "conversation-1", t0, 1_000);
        assert!(ledger
            .sweep(t0 + Duration::from_secs(299), 2_000)
            .is_empty());
        assert_eq!(
            ledger.active_reports(t0 + Duration::from_secs(299)).len(),
            1
        );
    }

    #[test]
    fn retention_evicts_sent_terminals_and_keeps_unsent_until_leak_bound() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        ledger.mark_terminal(
            "run-sent",
            "conversation-1",
            ChatRunLedgerState::Completed,
            "",
            "",
            t0,
            1_000,
        );
        ledger.mark_terminal_sent("run-sent");
        ledger.mark_terminal(
            "run-unsent",
            "conversation-2",
            ChatRunLedgerState::Failed,
            "boom",
            "run failed",
            t0,
            1_001,
        );

        // Past terminal_retention: sent entry evicted, unsent entry kept.
        ledger.sweep(t0 + Duration::from_secs(601), 2_000);
        let recent = ledger.recent_terminal_reports();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].run_id, "run-unsent");
        assert_eq!(ledger.unsent_terminals().len(), 1);

        // Past 3x terminal_retention: unsent entry evicted too (leak bound).
        ledger.sweep(t0 + Duration::from_secs(1_801), 3_000);
        assert!(ledger.recent_terminal_reports().is_empty());
        assert!(ledger.unsent_terminals().is_empty());
    }

    #[test]
    fn recent_terminal_reports_are_capped_newest_first() {
        let mut ledger = test_ledger();
        let t0 = Instant::now();
        for index in 0..6 {
            ledger.mark_terminal(
                &format!("run-{index}"),
                "conversation-1",
                ChatRunLedgerState::Completed,
                "",
                "",
                t0 + Duration::from_secs(index),
                1_000 + i64::try_from(index).unwrap(),
            );
        }

        let recent = ledger.recent_terminal_reports();
        assert_eq!(recent.len(), 4);
        assert_eq!(recent[0].run_id, "run-5");
        assert_eq!(recent[0].updated_at_ms, 1_005);
        assert_eq!(recent[3].run_id, "run-2");
    }
}
