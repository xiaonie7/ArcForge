package session

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/chatwire"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

// Ingress normalization: the three agent-facing envelope payloads (ChatEvent,
// ChatControlEvent, ChatRuntimeSnapshot) converge here into one append API on
// the conversation stream store. Payload shaping and tool-result trimming
// happen exactly once, so every subscriber observes identical events.

func (m *Manager) ingestChatEvent(requestID string, event *gatewayv1.ChatEvent) {
	if event == nil {
		return
	}
	s := m.convStreams
	runID := strings.TrimSpace(requestID)
	if runID == "" {
		return
	}
	now := time.Now()
	epoch := m.currentSessionEpoch()
	var presentedFile *durablePresentedFileWrite
	defer func() {
		if presentedFile != nil {
			s.persistPresentedFile(*presentedFile, now)
		}
	}()

	s.mu.Lock()
	defer s.mu.Unlock()

	conversationID := s.resolveConversationLocked(runID, strings.TrimSpace(event.GetConversationId()), now)
	if conversationID == "" {
		return
	}
	existingStream := s.streams[conversationID]
	streamWasUnknown := existingStream == nil ||
		(existingStream.lastSeq == 0 && existingStream.activity == nil)
	stream := s.streamLocked(conversationID, now)
	s.noteAgentEpochLocked(stream, epoch)

	payload := chatwire.EventPayload(event, 0)
	eventType, _ := payload["type"].(string)
	if eventType == "" {
		eventType = chatwire.EventTypeName(event.GetType())
	}

	switch event.GetType() {
	case gatewayv1.ChatEvent_DONE:
		delete(payload, "type")
		delete(payload, "seq")
		s.runFinishedLocked(stream, runID, "completed", "", "", payload, now)
		return
	case gatewayv1.ChatEvent_ERROR:
		message, _ := payload["message"].(string)
		delete(payload, "type")
		delete(payload, "seq")
		delete(payload, "message")
		s.runFinishedLocked(stream, runID, "failed", "", strings.TrimSpace(message), payload, now)
		return
	case gatewayv1.ChatEvent_USER_MESSAGE:
		if record := s.runs[runID]; record != nil && record.userMessageSeeded {
			// The gateway already appended this run's user_message at accept
			// time; swallow the agent echo so the message appears once.
			return
		}
	}

	if stream.runFinishedRecently(runID) {
		// Late straggler after a forced or duplicate terminal; drop it.
		return
	}
	if _, finishing := s.finishingRuns[runID]; finishing {
		return
	}

	if event.GetType() == gatewayv1.ChatEvent_USER_MESSAGE {
		// A GUI-local edit-resend: the desktop truncated its own history and
		// stamped the truncation base onto its user_message. Broadcast the
		// same rebased event the webui edit path seeds, so every subscriber
		// truncates before the new user message renders (webui commands never
		// reach here — their echo was swallowed above).
		if ref, ok := payload["base_message_ref"].(map[string]any); ok {
			messageID, _ := ref["message_id"].(string)
			contentHash, _ := ref["content_hash"].(string)
			if strings.TrimSpace(messageID) != "" || strings.TrimSpace(contentHash) != "" {
				record := s.runRecordLocked(runID, conversationID)
				if !record.rebaseSeeded {
					record.rebaseSeeded = true
					s.appendSeededPayloadsLocked(stream, runID, record.clientRequestID, []map[string]any{{
						"type":             StreamEventRebased,
						"base_message_ref": ref,
						"reason":           "edit_resend",
					}}, now)
				}
			}
		}
	}

	workdir, _ := payload["workdir"].(string)
	s.runStartedLocked(stream, runID, strings.TrimSpace(workdir), now)
	if stream.activity == nil || stream.activity.RunID != runID {
		// runStartedLocked declined (e.g. the run finished during
		// supersession bookkeeping); do not attribute events to another run.
		return
	}
	if streamWasUnknown && event.GetType() != gatewayv1.ChatEvent_USER_MESSAGE {
		// A mid-run delta recreated this stream (gateway restarted while the
		// run was streaming): the run's earlier events are unrecoverable from
		// the log, so late joiners must hydrate from the runtime snapshot.
		stream.runNeedsSnapshot = true
	}

	if event.GetType() == gatewayv1.ChatEvent_TOOL_STATUS {
		status, _ := payload["status"].(string)
		isCompaction, _ := payload["isCompaction"].(bool)
		stream.activity.ToolStatus = strings.TrimSpace(status)
		stream.activity.ToolStatusIsCompaction = isCompaction
		stream.activity.UpdatedAt = now
	}

	delete(payload, "seq")
	appended := s.appendEventLocked(stream, runID, eventType, payload, now)
	if eventType == "tool_result" {
		if payloadJSON, ok := durablePresentFilePayloadJSON(payload); ok {
			record := s.runRecordLocked(runID, conversationID)
			if record.clientRequestID != "" {
				file := ChatCommandPresentedFile{
					Seq:         appended.Seq,
					Workdir:     conversationRunWorkdirLocked(stream, runID),
					PayloadJSON: payloadJSON,
				}
				record.presentedFiles = append(record.presentedFiles, file)
				presentedFile = &durablePresentedFileWrite{
					clientRequestID: record.clientRequestID,
					runID:           runID,
					file:            file,
				}
			}
		}
	}
}

type durablePresentedFileWrite struct {
	clientRequestID string
	runID           string
	file            ChatCommandPresentedFile
}

func durablePresentFilePayloadJSON(payload map[string]any) (string, bool) {
	if payload == nil {
		return "", false
	}
	name, _ := payload["name"].(string)
	isError, hasErrorFlag := payload["isError"].(bool)
	details, hasDetails := payload["details"].(map[string]any)
	kind, _ := details["kind"].(string)
	if strings.TrimSpace(name) != "PresentFile" || !hasErrorFlag || isError ||
		!hasDetails || strings.TrimSpace(kind) != "display_file" {
		return "", false
	}
	data, err := json.Marshal(payload)
	if err != nil || len(data) == 0 || len(data) > maxDurablePresentedFilesJSON {
		return "", false
	}
	return string(data), true
}

func (s *conversationStreamStore) persistPresentedFile(write durablePresentedFileWrite, now time.Time) {
	store, ok := s.commandStore.(chatCommandPresentedFileStore)
	if !ok {
		return
	}
	if err := store.RecordPresentedFile(
		write.clientRequestID, write.runID, write.file, now,
	); err != nil {
		logChatCommandStoreError("record_presented_file", write.runID, err)
	}
}

func (m *Manager) ingestChatControl(requestID string, control *gatewayv1.ChatControlEvent) {
	if control == nil {
		return
	}
	s := m.convStreams
	runID := strings.TrimSpace(requestID)
	if runID == "" {
		runID = strings.TrimSpace(control.GetRequestId())
	}
	if runID == "" {
		return
	}
	controlType := strings.TrimSpace(control.GetType())
	if controlType == "" {
		controlType = strings.TrimSpace(control.GetState())
	}
	errorCode := strings.TrimSpace(control.GetErrorCode())
	message := strings.TrimSpace(control.GetMessage())
	now := time.Now()
	epoch := m.currentSessionEpoch()

	s.mu.Lock()
	defer s.mu.Unlock()

	conversationID := s.resolveConversationLocked(runID, strings.TrimSpace(control.GetConversationId()), now)
	if conversationID == "" {
		// A control for a run the gateway has no conversation for yet (the
		// binding signal must carry a conversation id); ignore.
		return
	}
	stream := s.streamLocked(conversationID, now)
	s.noteAgentEpochLocked(stream, epoch)

	switch controlType {
	case "started":
		s.runStartedLocked(stream, runID, "", now)
	case "completed":
		extra := map[string]any(nil)
		if message != "" {
			extra = map[string]any{"final_text": message}
		}
		s.runFinishedLocked(stream, runID, controlType, errorCode, "", extra, now)
	case "failed", "cancelled":
		s.runFinishedLocked(stream, runID, controlType, errorCode, message, nil, now)
	case "queued_in_gui":
		s.markRunQueuedInGUILocked(stream, runID, now)
	case "accepted", "delivered", "claimed", "starting":
		record := s.runRecordLocked(runID, conversationID)
		s.markRunQueuedLocked(stream, runID, record.clientRequestID, now)
		if stream.activity != nil && stream.activity.RunID == runID &&
			stream.activity.State == RunActivityQueued &&
			s.commandStore != nil && record.clientRequestID != "" {
			if err := s.markChatCommandLocked(
				record.clientRequestID, runID, "queued", "accepted", now,
			); err != nil && !s.chatCommandTerminalLocked(record.clientRequestID, runID) {
				logChatCommandStoreError("mark_queued", runID, err)
			}
		}
	}
}

// markRunQueuedInGUILocked handles a command the desktop app parked in its
// prompt queue: the run will not start now. Any provisionally seeded entries
// are compensated with a run_queued event so clients drop them (the prompt is
// visible in the queue UI instead), and the agent's later user_message echo —
// when the queued item finally runs — must pass through.
func (s *conversationStreamStore) markRunQueuedInGUILocked(
	stream *conversationStream,
	runID string,
	now time.Time,
) {
	if stream.runFinishedRecently(runID) {
		return
	}
	record := s.runRecordLocked(runID, stream.conversationID)
	record.queuedInGUI = true
	seeded := record.userMessageSeeded
	record.userMessageSeeded = false
	// Seeds deferred at accept time never reached the log: drop them. The
	// prompt now lives in the desktop queue (editable there), and the agent's
	// echo is the authoritative text when the item eventually runs.
	record.deferredSeeds = nil

	if seeded {
		payload := map[string]any{}
		if record.clientRequestID != "" {
			payload["client_request_id"] = record.clientRequestID
		}
		s.appendEventLocked(stream, runID, StreamEventRunQueued, payload, now)
	}
	if stream.activity != nil && stream.activity.RunID == runID {
		stream.activity = nil
		s.publishActivityLocked(stream, now)
	}
	s.fireCommandUpdateLocked(ChatCommandUpdate{
		RunID:           runID,
		ClientRequestID: record.clientRequestID,
		ConversationID:  stream.conversationID,
		Phase:           "queued_in_gui",
	})
}

func (m *Manager) ingestRuntimeSnapshot(snapshot *gatewayv1.ChatRuntimeSnapshot) {
	if snapshot == nil {
		return
	}
	s := m.convStreams
	runID := strings.TrimSpace(snapshot.GetRunId())
	conversationID := strings.TrimSpace(snapshot.GetConversationId())
	if runID == "" || conversationID == "" {
		return
	}
	state := strings.TrimSpace(snapshot.GetState())
	now := time.Now()
	epoch := m.currentSessionEpoch()

	s.mu.Lock()
	defer s.mu.Unlock()

	conversationID = s.resolveConversationLocked(runID, conversationID, now)
	existingStream := s.streams[conversationID]
	streamWasUnknown := existingStream == nil || (existingStream.lastSeq == 0 && existingStream.activity == nil)
	stream := s.streamLocked(conversationID, now)
	s.noteAgentEpochLocked(stream, epoch)

	switch state {
	case "completed", "failed", "cancelled":
		s.runFinishedLocked(stream, runID, state, "", "", nil, now)
		return
	}
	if stream.runFinishedRecently(runID) {
		return
	}

	next := &RunSnapshot{
		RunID:                  runID,
		Revision:               snapshot.GetRevision(),
		EntriesJSON:            strings.TrimSpace(snapshot.GetEntriesJson()),
		ToolStatus:             strings.TrimSpace(snapshot.GetToolStatus()),
		ToolStatusIsCompaction: snapshot.GetToolStatusIsCompaction(),
		Workdir:                strings.TrimSpace(snapshot.GetCwd()),
		AsOfSeq:                stream.lastSeq,
		UpdatedAt:              now,
	}
	if current := stream.latestSnapshot; current != nil &&
		current.RunID == runID &&
		current.Revision > next.Revision {
		// Stale revision; keep the newer snapshot.
		return
	}
	stream.latestSnapshot = next
	stream.updatedAt = now
	stream.lastEventAt = now

	if state == "running" || state == "" {
		if streamWasUnknown {
			// The gateway (re)started while this run was already streaming;
			// buffered history is gone, so late joiners need the snapshot.
			stream.runNeedsSnapshot = true
		}
		s.runStartedLocked(stream, runID, next.Workdir, now)
		if stream.activity != nil && stream.activity.RunID == runID {
			if next.ToolStatus != "" || stream.activity.ToolStatus != "" {
				stream.activity.ToolStatus = next.ToolStatus
				stream.activity.ToolStatusIsCompaction = next.ToolStatusIsCompaction
			}
			stream.activity.UpdatedAt = now
		}
	}

	if stream.snapshotDirty {
		// The agent reconnected mid-run: tokens streamed during the outage are
		// unrecoverable, so push the snapshot inline for attached subscribers.
		stream.snapshotDirty = false
		s.publishSnapshotLocked(stream, runID, next, now)
	}
}

// publishSnapshotLocked delivers a seq-less snapshot event to current
// subscribers without storing it in the log.
func (s *conversationStreamStore) publishSnapshotLocked(
	stream *conversationStream,
	runID string,
	snapshot *RunSnapshot,
	now time.Time,
) {
	payload := map[string]any{
		"conversation_id":           stream.conversationID,
		"run_id":                    runID,
		"type":                      StreamEventSnapshot,
		"revision":                  snapshot.Revision,
		"entries_json":              snapshot.EntriesJSON,
		"tool_status":               snapshot.ToolStatus,
		"tool_status_is_compaction": snapshot.ToolStatusIsCompaction,
		"as_of_seq":                 snapshot.AsOfSeq,
	}
	event := &ConversationEvent{
		ConversationID: stream.conversationID,
		RunID:          runID,
		Seq:            0,
		Type:           StreamEventSnapshot,
		Payload:        payload,
		ReceivedAt:     now,
	}
	s.publishLocked(stream, event)
}

// resolveConversationLocked determines the conversation a run belongs to,
// binding a pending webui command when the first agent signal carries a
// conversation id.
func (s *conversationStreamStore) resolveConversationLocked(
	runID string,
	conversationID string,
	now time.Time,
) string {
	if pending := s.pendingRuns[runID]; pending != nil && conversationID != "" {
		s.bindPendingRunLocked(pending, conversationID, now)
	}
	if conversationID != "" {
		s.runRecordLocked(runID, conversationID)
		return conversationID
	}
	if record := s.runs[runID]; record != nil {
		return record.conversationID
	}
	return ""
}

func (s *conversationStreamStore) bindPendingRunLocked(
	pending *pendingChatRun,
	conversationID string,
	now time.Time,
) {
	delete(s.pendingRuns, pending.runID)
	stream := s.streamLocked(conversationID, now)
	if pending.workdir != "" {
		stream.workdir = pending.workdir
	}
	record := s.runRecordLocked(pending.runID, conversationID)
	record.clientRequestID = pending.clientRequestID
	s.markRunQueuedLocked(stream, pending.runID, pending.clientRequestID, now)
	acceptedSeq := s.appendSeededPayloadsLocked(
		stream, pending.runID, pending.clientRequestID, pending.seeded, now,
	)
	record.userMessageSeeded = seededPayloadsIncludeUserMessage(pending.seeded)
	if err := s.updateChatCommandDedupeLocked(
		pending.clientRequestID,
		pending.runID,
		conversationID,
		acceptedSeq,
		now,
	); err != nil {
		logChatCommandStoreError("bind_pending", pending.runID, err)
	}
	s.fireCommandUpdateLocked(ChatCommandUpdate{
		RunID:           pending.runID,
		ClientRequestID: pending.clientRequestID,
		ConversationID:  conversationID,
		Phase:           "bound",
	})
}

// noteAgentEpochLocked tracks the agent session epoch per stream: when the
// agent reconnects mid-run, tokens streamed during the outage are lost, so
// the next runtime snapshot is pushed inline and offered to late joiners.
func (s *conversationStreamStore) noteAgentEpochLocked(stream *conversationStream, epoch uint64) {
	if epoch == 0 || stream.agentEpoch == epoch {
		return
	}
	if stream.agentEpoch != 0 && stream.activity != nil {
		stream.snapshotDirty = true
		stream.runNeedsSnapshot = true
	}
	stream.agentEpoch = epoch
}
