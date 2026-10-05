/** SQL for the mail area (phase 1). Appended to db.ts MIGRATIONS; kept here so the
 *  store's tests can run the very same statements on an in-memory database. */
export const MAIL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mail_account (
    id           TEXT PRIMARY KEY,
    provider     TEXT NOT NULL DEFAULT 'imap',
    address      TEXT NOT NULL,
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL,
    username     TEXT NOT NULL,
    mailbox      TEXT NOT NULL DEFAULT 'INBOX',
    secret_ref   TEXT NOT NULL,          -- key into the encrypted secret store, never the secret
    uid_validity INTEGER,
    last_uid     INTEGER NOT NULL DEFAULT 0,
    last_poll_at INTEGER,
    next_poll_at INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'ok',
    error_count  INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
  );
  CREATE TABLE IF NOT EXISTS mail_message (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
    message_id      TEXT NOT NULL,       -- normalised Message-ID
    uid             INTEGER NOT NULL,
    thread_id       TEXT NOT NULL,
    from_name       TEXT NOT NULL,
    from_addr       TEXT NOT NULL,
    to_json         TEXT NOT NULL,
    subject         TEXT NOT NULL,
    received_at     INTEGER NOT NULL,
    body_text       TEXT,                -- NULL once purged by retention
    body_hash       TEXT NOT NULL,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    attachments_json TEXT NOT NULL DEFAULT '[]',  -- metadata only
    state           TEXT NOT NULL DEFAULT 'new',
    ingested_at     INTEGER NOT NULL,
    UNIQUE (account_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mail_message_thread ON mail_message(thread_id);
  CREATE INDEX IF NOT EXISTS idx_mail_message_received ON mail_message(received_at DESC);
  CREATE TABLE IF NOT EXISTS mail_triage (
    message_row_id INTEGER PRIMARY KEY REFERENCES mail_message(id) ON DELETE CASCADE,
    category       TEXT NOT NULL,
    urgency        TEXT NOT NULL,
    project_key    TEXT,                 -- NULL = unassigned ("Da assegnare")
    via            TEXT NOT NULL,        -- rule | jira-key | model | manual | none
    rule_id        INTEGER,
    confidence     REAL,
    needs_reply    INTEGER NOT NULL DEFAULT 0,
    summary        TEXT NOT NULL DEFAULT '',
    model          TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mail_rule (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    pattern     TEXT NOT NULL,
    project_key TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1
  );
`;
