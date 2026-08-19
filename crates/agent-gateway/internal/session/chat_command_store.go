package session

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// chatCommandStore is the durable idempotency boundary for channel/web UI
// commands. The conversation stream keeps a memory cache, while this store
// remains authoritative across Gateway restarts.
type chatCommandStore interface {
	Lookup(clientRequestID string, now time.Time) (*chatCommandDedupeRecord, error)
	Claim(clientRequestID, runID, conversationID string, acceptedSeq int64, now time.Time) (*chatCommandDedupeRecord, bool, error)
	Bind(clientRequestID, runID, conversationID string, acceptedSeq int64, now time.Time) error
	Mark(clientRequestID, runID, state, phase string, now time.Time) error
	Finish(clientRequestID, runID, status, errorCode, message string, payload map[string]any, now time.Time) error
	Recoverable(now time.Time) ([]*chatCommandDedupeRecord, error)
	ExpireRecovering(now time.Time) ([]*chatCommandDedupeRecord, error)
	Reap(now time.Time) error
}

// chatCommandPresentedFileStore is implemented by durable stores that retain
// the metadata needed to replay explicit PresentFile results after a Gateway
// restart. It stays separate from chatCommandStore so lightweight test stores
// and non-durable implementations do not need no-op artifact methods.
type chatCommandPresentedFileStore interface {
	RecordPresentedFile(clientRequestID, runID string, file ChatCommandPresentedFile, now time.Time) error
}

const (
	maxDurablePresentedFileEvents = 64
	maxDurablePresentedFilesJSON  = 512 * 1024
	chatCommandReapBatchSize      = 256
)

// SQLiteChatCommandStore persists canonical runs and their terminal result.
// It is intentionally small and independent from transcript/event storage.
type SQLiteChatCommandStore struct{ db *sql.DB }

func OpenSQLiteChatCommandStore(path string) (*SQLiteChatCommandStore, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("chat command sqlite path is required")
	}
	if !strings.HasPrefix(path, "file:") {
		parent := filepath.Dir(path)
		if parent != "." {
			if err := os.MkdirAll(parent, 0o700); err != nil {
				return nil, fmt.Errorf("create chat command sqlite directory: %w", err)
			}
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
	} {
		if _, err = db.Exec(pragma); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("sqlite %s: %w", pragma, err)
		}
	}
	if _, err = db.Exec(`CREATE TABLE IF NOT EXISTS chat_command_dedupe (
                client_request_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL DEFAULT '',
                accepted_seq INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL DEFAULT 'accepted',
                dispatch_phase TEXT NOT NULL DEFAULT 'accepted',
                lease_until_ms INTEGER,
                terminal_status TEXT NOT NULL DEFAULT '',
                terminal_error_code TEXT NOT NULL DEFAULT '',
                terminal_message TEXT NOT NULL DEFAULT '',
		terminal_payload_json TEXT NOT NULL DEFAULT '{}',
		presented_files_json TEXT NOT NULL DEFAULT '[]',
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL
        )`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create chat_command_dedupe: %w", err)
	}
	if err = ensureSQLiteColumn(db, "chat_command_dedupe", "presented_files_json",
		"TEXT NOT NULL DEFAULT '[]'"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate chat_command_dedupe presented files: %w", err)
	}
	if _, err = db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS chat_command_dedupe_run_id
		ON chat_command_dedupe(run_id)`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("index chat_command_dedupe run_id: %w", err)
	}
	if _, err = db.Exec(`CREATE INDEX IF NOT EXISTS chat_command_dedupe_expiry
		ON chat_command_dedupe(expires_at_ms)`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("index chat_command_dedupe expiry: %w", err)
	}
	// Commands interrupted by a Gateway restart remain canonical but enter a
	// bounded reconciliation window. They are never dispatched again: Desktop
	// run reports either recover them or the reaper finalizes them as unknown.
	// Terminal rows are intentionally excluded: once an outcome has been
	// published and persisted, subsequent restarts must not make it nonterminal
	// again.
	recoveryStarted := time.Now()
	if _, err = db.Exec(`UPDATE chat_command_dedupe SET state = 'recovering',
		dispatch_phase = 'restart_recovering', terminal_status = '',
		terminal_error_code = '', terminal_message = '', terminal_payload_json = '{}',
		lease_until_ms = ?, updated_at_ms = ?
		WHERE state <> 'terminal'`,
		recoveryStarted.Add(chatCommandRecoveryGrace).UnixMilli(), recoveryStarted.UnixMilli()); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("reconcile chat commands after restart: %w", err)
	}
	return &SQLiteChatCommandStore{db: db}, nil
}

func ensureSQLiteColumn(db *sql.DB, table, column, declaration string) error {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var cid int
		var name, dataType string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			_ = rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if found {
		return nil
	}
	_, err = db.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + declaration)
	return err
}

func (s *SQLiteChatCommandStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SQLiteChatCommandStore) Lookup(clientRequestID string, now time.Time) (*chatCommandDedupeRecord, error) {
	if s == nil || s.db == nil || strings.TrimSpace(clientRequestID) == "" {
		return nil, nil
	}
	var r chatCommandDedupeRecord
	var created int64
	var presentedFilesJSON string
	err := s.db.QueryRow(`SELECT run_id, conversation_id, accepted_seq, created_at_ms,
		state, dispatch_phase, terminal_status, terminal_error_code, terminal_message, terminal_payload_json,
		presented_files_json
                FROM chat_command_dedupe WHERE client_request_id = ? AND expires_at_ms > ?`,
		strings.TrimSpace(clientRequestID), now.UnixMilli()).Scan(
		&r.runID, &r.conversationID, &r.acceptedSeq, &created, &r.state, &r.dispatchPhase,
		&r.terminalStatus, &r.terminalErrorCode, &r.terminalMessage, &r.terminalPayloadJSON,
		&presentedFilesJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.clientRequestID = strings.TrimSpace(clientRequestID)
	r.createdAt = time.UnixMilli(created)
	r.presentedFiles = decodePresentedFiles(presentedFilesJSON)
	return &r, nil
}

func (s *SQLiteChatCommandStore) Claim(
	clientRequestID, runID, conversationID string,
	acceptedSeq int64,
	now time.Time,
) (*chatCommandDedupeRecord, bool, error) {
	clientRequestID = strings.TrimSpace(clientRequestID)
	runID = strings.TrimSpace(runID)
	if s == nil || s.db == nil || clientRequestID == "" || runID == "" {
		return nil, false, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	created := now.UnixMilli()
	result, err := tx.Exec(`INSERT INTO chat_command_dedupe
		(client_request_id, run_id, conversation_id, accepted_seq, lease_until_ms, created_at_ms, updated_at_ms, expires_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(client_request_id) DO UPDATE SET
			run_id = excluded.run_id, conversation_id = excluded.conversation_id,
			accepted_seq = excluded.accepted_seq, state = 'accepted', dispatch_phase = 'accepted', lease_until_ms = excluded.lease_until_ms,
			terminal_status = '', terminal_error_code = '', terminal_message = '', terminal_payload_json = '{}',
			presented_files_json = '[]',
			created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms,
			expires_at_ms = excluded.expires_at_ms
		WHERE chat_command_dedupe.expires_at_ms <= ?`,
		clientRequestID, runID, strings.TrimSpace(conversationID), acceptedSeq,
		now.Add(pendingChatRunRetention).UnixMilli(), created, created,
		now.Add(chatCommandDedupeRetention).UnixMilli(), created)
	if err != nil {
		return nil, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, false, err
	}
	var record chatCommandDedupeRecord
	var recordCreated int64
	var presentedFilesJSON string
	err = tx.QueryRow(`SELECT run_id, conversation_id, accepted_seq, created_at_ms,
		state, dispatch_phase, terminal_status, terminal_error_code, terminal_message, terminal_payload_json,
		presented_files_json
		FROM chat_command_dedupe WHERE client_request_id = ? AND expires_at_ms > ?`,
		clientRequestID, created).Scan(
		&record.runID, &record.conversationID, &record.acceptedSeq, &recordCreated,
		&record.state, &record.dispatchPhase, &record.terminalStatus, &record.terminalErrorCode,
		&record.terminalMessage, &record.terminalPayloadJSON, &presentedFilesJSON,
	)
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	record.clientRequestID = clientRequestID
	record.createdAt = time.UnixMilli(recordCreated)
	record.presentedFiles = decodePresentedFiles(presentedFilesJSON)
	return &record, affected == 0, nil
}

func (s *SQLiteChatCommandStore) RecordPresentedFile(
	clientRequestID, runID string,
	file ChatCommandPresentedFile,
	now time.Time,
) error {
	if s == nil || s.db == nil || strings.TrimSpace(runID) == "" {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var encoded string
	err = tx.QueryRow(`SELECT presented_files_json FROM chat_command_dedupe
		WHERE run_id = ? AND (? = '' OR client_request_id = ?)`,
		strings.TrimSpace(runID), strings.TrimSpace(clientRequestID), strings.TrimSpace(clientRequestID),
	).Scan(&encoded)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("canonical chat command row was not found")
		}
		return err
	}
	files := decodePresentedFiles(encoded)
	for _, existing := range files {
		if existing.Seq == file.Seq && existing.PayloadJSON == file.PayloadJSON {
			return tx.Commit()
		}
	}
	if len(files) >= maxDurablePresentedFileEvents {
		return errors.New("durable presented file event limit exceeded")
	}
	files = append(files, file)
	data, err := json.Marshal(files)
	if err != nil {
		return fmt.Errorf("marshal presented files: %w", err)
	}
	if len(data) > maxDurablePresentedFilesJSON {
		return errors.New("durable presented file metadata limit exceeded")
	}
	result, err := tx.Exec(`UPDATE chat_command_dedupe SET presented_files_json = ?,
		updated_at_ms = ?, expires_at_ms = ?
		WHERE run_id = ? AND (? = '' OR client_request_id = ?)`,
		string(data), now.UnixMilli(), now.Add(chatCommandDedupeRetention).UnixMilli(),
		strings.TrimSpace(runID), strings.TrimSpace(clientRequestID), strings.TrimSpace(clientRequestID),
	)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errors.New("canonical chat command row was not updated")
	}
	return tx.Commit()
}

func decodePresentedFiles(encoded string) []ChatCommandPresentedFile {
	var files []ChatCommandPresentedFile
	if strings.TrimSpace(encoded) == "" || json.Unmarshal([]byte(encoded), &files) != nil {
		return nil
	}
	return files
}

func (s *SQLiteChatCommandStore) Bind(clientRequestID, runID, conversationID string, acceptedSeq int64, now time.Time) error {
	if s == nil || s.db == nil || strings.TrimSpace(clientRequestID) == "" {
		return nil
	}
	conversationID = strings.TrimSpace(conversationID)
	result, err := s.db.Exec(`UPDATE chat_command_dedupe SET conversation_id = CASE
			WHEN conversation_id = '' AND ? <> '' THEN ? ELSE conversation_id END,
                accepted_seq = CASE WHEN ? > accepted_seq THEN ? ELSE accepted_seq END,
				updated_at_ms = ?, expires_at_ms = ?
		WHERE client_request_id = ? AND run_id = ?
		AND (? = '' OR conversation_id = '' OR conversation_id = ?)`,
		conversationID, conversationID, acceptedSeq, acceptedSeq,
		now.UnixMilli(), now.Add(chatCommandDedupeRetention).UnixMilli(),
		strings.TrimSpace(clientRequestID), strings.TrimSpace(runID), conversationID, conversationID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errors.New("canonical chat command row was not updated")
	}
	return nil
}

func (s *SQLiteChatCommandStore) Mark(clientRequestID, runID, state, phase string, now time.Time) error {
	if s == nil || s.db == nil || strings.TrimSpace(runID) == "" {
		return nil
	}
	result, err := s.db.Exec(`UPDATE chat_command_dedupe SET state = ?, dispatch_phase = ?,
		lease_until_ms = CASE WHEN ? = 'terminal' THEN NULL ELSE ? END,
		terminal_status = '', terminal_error_code = '', terminal_message = '', terminal_payload_json = '{}',
		updated_at_ms = ?, expires_at_ms = ?
		WHERE run_id = ? AND (? = '' OR client_request_id = ?)
		AND state <> 'terminal'`,
		strings.TrimSpace(state), strings.TrimSpace(phase), strings.TrimSpace(state),
		now.Add(pendingChatRunRetention).UnixMilli(), now.UnixMilli(), now.Add(chatCommandDedupeRetention).UnixMilli(),
		strings.TrimSpace(runID), strings.TrimSpace(clientRequestID), strings.TrimSpace(clientRequestID))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errors.New("canonical chat command row was not marked")
	}
	return nil
}

func (s *SQLiteChatCommandStore) Finish(
	clientRequestID, runID, status, errorCode, message string,
	payload map[string]any,
	now time.Time,
) error {
	if s == nil || s.db == nil || strings.TrimSpace(runID) == "" {
		return nil
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal terminal payload: %w", err)
	}
	result, err := s.db.Exec(`UPDATE chat_command_dedupe SET state = 'terminal', dispatch_phase = 'finished',
		terminal_status = ?, terminal_error_code = ?, terminal_message = ?, terminal_payload_json = ?,
		updated_at_ms = ?, expires_at_ms = ?
		WHERE run_id = ? AND (? = '' OR client_request_id = ?)
		AND state <> 'terminal'`, strings.TrimSpace(status), strings.TrimSpace(errorCode),
		message, string(payloadJSON), now.UnixMilli(), now.Add(chatCommandDedupeRetention).UnixMilli(),
		strings.TrimSpace(runID), strings.TrimSpace(clientRequestID), strings.TrimSpace(clientRequestID))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		var existingStatus, existingErrorCode, existingMessage, existingPayload string
		err := s.db.QueryRow(`SELECT terminal_status, terminal_error_code, terminal_message, terminal_payload_json
			FROM chat_command_dedupe
			WHERE run_id = ? AND (? = '' OR client_request_id = ?) AND state = 'terminal'`,
			strings.TrimSpace(runID), strings.TrimSpace(clientRequestID), strings.TrimSpace(clientRequestID),
		).Scan(&existingStatus, &existingErrorCode, &existingMessage, &existingPayload)
		if err == nil &&
			existingStatus == strings.TrimSpace(status) &&
			existingErrorCode == strings.TrimSpace(errorCode) &&
			existingMessage == message &&
			existingPayload == string(payloadJSON) {
			return nil
		}
		return errors.New("canonical chat command row was not finished")
	}
	return nil
}

func (s *SQLiteChatCommandStore) Recoverable(now time.Time) ([]*chatCommandDedupeRecord, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	rows, err := s.db.Query(`SELECT client_request_id, run_id, conversation_id, accepted_seq, created_at_ms,
		state, dispatch_phase, terminal_status, terminal_error_code, terminal_message, terminal_payload_json,
		presented_files_json
		FROM chat_command_dedupe
		WHERE state = 'recovering' AND expires_at_ms > ?`, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]*chatCommandDedupeRecord, 0)
	for rows.Next() {
		record := &chatCommandDedupeRecord{}
		var created int64
		var presentedFilesJSON string
		if err := rows.Scan(
			&record.clientRequestID, &record.runID, &record.conversationID, &record.acceptedSeq, &created,
			&record.state, &record.dispatchPhase, &record.terminalStatus, &record.terminalErrorCode,
			&record.terminalMessage, &record.terminalPayloadJSON, &presentedFilesJSON,
		); err != nil {
			return nil, err
		}
		record.createdAt = time.UnixMilli(created)
		record.presentedFiles = decodePresentedFiles(presentedFilesJSON)
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

func (s *SQLiteChatCommandStore) ExpireRecovering(now time.Time) ([]*chatCommandDedupeRecord, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.Query(`SELECT client_request_id, run_id, conversation_id, accepted_seq, created_at_ms
		FROM chat_command_dedupe
		WHERE state = 'recovering' AND lease_until_ms <= ? AND expires_at_ms > ?`,
		now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return nil, err
	}
	records := make([]*chatCommandDedupeRecord, 0)
	for rows.Next() {
		record := &chatCommandDedupeRecord{}
		var created int64
		if err := rows.Scan(
			&record.clientRequestID, &record.runID, &record.conversationID, &record.acceptedSeq, &created,
		); err != nil {
			_ = rows.Close()
			return nil, err
		}
		record.createdAt = time.UnixMilli(created)
		records = append(records, record)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(records) == 0 {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return records, nil
	}
	message := "Gateway restarted before the command could be reconciled with the desktop runtime."
	result, err := tx.Exec(`UPDATE chat_command_dedupe SET state = 'terminal',
		dispatch_phase = 'restart_unknown', lease_until_ms = NULL,
		terminal_status = 'unknown', terminal_error_code = 'gateway_restart',
		terminal_message = ?, terminal_payload_json = '{}', updated_at_ms = ?, expires_at_ms = ?
		WHERE state = 'recovering' AND lease_until_ms <= ? AND expires_at_ms > ?`,
		message, now.UnixMilli(), now.Add(chatCommandDedupeRetention).UnixMilli(),
		now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return nil, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if affected != int64(len(records)) {
		return nil, errors.New("recovering chat command set changed while expiring")
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	for _, record := range records {
		record.state = "terminal"
		record.dispatchPhase = "restart_unknown"
		record.terminalStatus = "unknown"
		record.terminalErrorCode = "gateway_restart"
		record.terminalMessage = message
		record.terminalPayloadJSON = "{}"
	}
	return records, nil
}

func (s *SQLiteChatCommandStore) Reap(now time.Time) error {
	if s == nil || s.db == nil {
		return nil
	}
	_, err := s.db.Exec(`DELETE FROM chat_command_dedupe WHERE rowid IN (
		SELECT rowid FROM chat_command_dedupe WHERE expires_at_ms <= ?
		ORDER BY expires_at_ms, rowid LIMIT ?
	)`, now.UnixMilli(), chatCommandReapBatchSize)
	return err
}
