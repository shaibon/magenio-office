/**
 * Mail storage over a minimal SQL interface, so the same code runs on
 * better-sqlite3 in the app and on `node:sqlite` in the tests. Bind values are
 * only ever strings, numbers or null (node:sqlite rejects anything else).
 */
import { createHash } from 'node:crypto';
import type { Classification, MailRule, MailRuleKind, RawMail, Route } from '../../shared/mail';

export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqlDb { exec(sql: string): unknown; prepare(sql: string): SqlStatement }

export interface MailAccountRow {
  id: string; provider: string; address: string; host: string; port: number; username: string; mailbox: string;
  secretRef: string; uidValidity: number | null; lastUid: number; lastPollAt: number | null; nextPollAt: number;
  status: 'ok' | 'error'; errorCount: number; lastError: string | null;
}
/** What the UI may see of an account: never the secret reference's value. */
export type MailAccountPublic = Omit<MailAccountRow, 'secretRef'> & { hasSecret: boolean };

export interface MailMessageSummary {
  id: number; accountId: string; threadId: string; fromName: string; fromAddr: string; subject: string;
  receivedAt: number; hasAttachments: boolean; state: string;
  triage: {
    category: string; urgency: string; projectKey: string | null; via: string; confidence: number | null;
    needsReply: boolean; summary: string; suggestedAction: string;
  } | null;
}
export interface MailMessageDetail extends MailMessageSummary {
  to: string[]; /** null once retention purged it */ bodyText: string | null; bodyHash: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

export type MailMessageFilter = MessageFilter;
export interface MessageFilter {
  accountId?: string; projectKey?: string; unassigned?: boolean; threadId?: string; state?: string;
  limit?: number; before?: number;
}

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v);

const accountFrom = (r: Row): MailAccountRow => ({
  id: String(r.id), provider: String(r.provider), address: String(r.address), host: String(r.host), port: n(r.port),
  username: String(r.username), mailbox: String(r.mailbox), secretRef: String(r.secret_ref),
  uidValidity: r.uid_validity == null ? null : n(r.uid_validity), lastUid: n(r.last_uid),
  lastPollAt: r.last_poll_at == null ? null : n(r.last_poll_at), nextPollAt: n(r.next_poll_at),
  status: r.status === 'error' ? 'error' : 'ok', errorCount: n(r.error_count), lastError: r.last_error == null ? null : String(r.last_error)
});

const summaryFrom = (r: Row): MailMessageSummary => ({
  id: n(r.id), accountId: String(r.account_id), threadId: String(r.thread_id), fromName: String(r.from_name),
  fromAddr: String(r.from_addr), subject: String(r.subject), receivedAt: n(r.received_at),
  hasAttachments: n(r.has_attachments) === 1, state: String(r.state),
  triage: r.t_category == null ? null : {
    category: String(r.t_category), urgency: String(r.t_urgency),
    projectKey: r.t_project == null ? null : String(r.t_project), via: String(r.t_via),
    confidence: r.t_conf == null ? null : n(r.t_conf), needsReply: n(r.t_reply) === 1, summary: String(r.t_summary), suggestedAction: String(r.t_action ?? '')
  }
});

const SELECT_MESSAGE = `
  SELECT m.*, t.category AS t_category, t.urgency AS t_urgency, t.project_key AS t_project, t.via AS t_via,
         t.confidence AS t_conf, t.needs_reply AS t_reply, t.summary AS t_summary, t.suggested_action AS t_action
  FROM mail_message m LEFT JOIN mail_triage t ON t.message_row_id = m.id`;

export class MailStore {
  constructor(private readonly db: SqlDb) {}

  /* accounts */
  upsertAccount(a: { id: string; address: string; host: string; port: number; username: string; mailbox: string; secretRef: string }): void {
    this.db.prepare(
      `INSERT INTO mail_account (id, address, host, port, username, mailbox, secret_ref) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET address = excluded.address, host = excluded.host, port = excluded.port,
         username = excluded.username, mailbox = excluded.mailbox, secret_ref = excluded.secret_ref`
    ).run(a.id, a.address, a.host, a.port, a.username, a.mailbox, a.secretRef);
  }
  getAccount(id: string): MailAccountRow | null {
    const r = this.db.prepare('SELECT * FROM mail_account WHERE id = ?').get(id) as Row | undefined;
    return r ? accountFrom(r) : null;
  }
  listAccounts(): MailAccountRow[] {
    return (this.db.prepare('SELECT * FROM mail_account ORDER BY address').all() as Row[]).map(accountFrom);
  }
  removeAccount(id: string): void { this.db.prepare('DELETE FROM mail_account WHERE id = ?').run(id); }
  /** After a good poll: move the cursor, clear the error state, schedule the next. */
  markPolled(id: string, p: { lastUid: number; uidValidity: number | null; at: number; nextPollAt: number }): void {
    this.db.prepare(
      `UPDATE mail_account SET last_uid = ?, uid_validity = ?, last_poll_at = ?, next_poll_at = ?, status = 'ok', error_count = 0, last_error = NULL WHERE id = ?`
    ).run(p.lastUid, p.uidValidity, p.at, p.nextPollAt, id);
  }
  setCursor(id: string, lastUid: number): void {
    this.db.prepare('UPDATE mail_account SET last_uid = ? WHERE id = ?').run(lastUid, id);
  }
  markFailed(id: string, p: { error: string; at: number; nextPollAt: number }): void {
    this.db.prepare(
      `UPDATE mail_account SET status = 'error', error_count = error_count + 1, last_error = ?, last_poll_at = ?, next_poll_at = ? WHERE id = ?`
    ).run(p.error.slice(0, 300), p.at, p.nextPollAt, id);
  }

  /* messages */
  threadOf(accountId: string, normalizedMessageId: string): string | null {
    const r = this.db.prepare('SELECT thread_id FROM mail_message WHERE account_id = ? AND message_id = ?').get(accountId, normalizedMessageId) as Row | undefined;
    return r ? String(r.thread_id) : null;
  }
  /** Idempotent insert: returns the new row id, or null if this Message-ID is already stored. */
  insertMessage(accountId: string, m: RawMail, p: { threadId: string; body: string; now: number }): number | null {
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO mail_message (account_id, message_id, uid, thread_id, from_name, from_addr, to_json, subject,
         received_at, body_text, body_hash, has_attachments, attachments_json, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      accountId, m.messageId, m.uid, p.threadId, m.from.name.slice(0, 200), m.from.address, JSON.stringify(m.to), m.subject.slice(0, 500),
      m.date, p.body, createHash('sha256').update(p.body, 'utf8').digest('hex'), m.attachments.length ? 1 : 0,
      JSON.stringify(m.attachments), p.now
    );
    return Number(res.changes) === 0 ? null : Number(res.lastInsertRowid);
  }
  saveTriage(rowId: number, t: {
    category: string; urgency: string; route: Route | null; classification: Classification | null; model: string | null; at: number;
  }): void {
    const c = t.classification;
    this.db.prepare(
      `INSERT OR REPLACE INTO mail_triage (message_row_id, category, urgency, project_key, via, rule_id, confidence, needs_reply, summary, suggested_action, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(rowId, t.category, t.urgency, t.route?.projectKey ?? null, t.route?.via ?? 'none', t.route?.ruleId ?? null,
      c?.confidence ?? null, c?.needsReply ? 1 : 0, c?.summary ?? '', c?.suggestedAction ?? '', t.model, t.at);
    this.db.prepare('UPDATE mail_message SET state = ? WHERE id = ?').run(t.route ? 'routed' : 'classified', rowId);
  }
  /** Manual assignment from the UI; null returns the message to "Da assegnare". */
  assign(rowId: number, projectKey: string | null): boolean {
    const r = this.db.prepare(
      `UPDATE mail_triage SET project_key = ?, via = ? WHERE message_row_id = ?`
    ).run(projectKey, projectKey ? 'manual' : 'none', rowId);
    if (Number(r.changes) === 0) return false;
    this.db.prepare('UPDATE mail_message SET state = ? WHERE id = ?').run(projectKey ? 'routed' : 'classified', rowId);
    return true;
  }
  listMessages(f: MessageFilter = {}): MailMessageSummary[] {
    const where: string[] = []; const args: unknown[] = [];
    if (f.accountId) { where.push('m.account_id = ?'); args.push(f.accountId); }
    if (f.threadId) { where.push('m.thread_id = ?'); args.push(f.threadId); }
    if (f.state) { where.push('m.state = ?'); args.push(f.state); }
    if (f.projectKey) { where.push('t.project_key = ?'); args.push(f.projectKey.toUpperCase()); }
    if (f.unassigned) where.push('t.project_key IS NULL');
    if (f.before) { where.push('m.received_at < ?'); args.push(f.before); }
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200);
    const sql = `${SELECT_MESSAGE} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.received_at DESC, m.id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(summaryFrom);
  }
  getMessage(rowId: number): MailMessageDetail | null {
    const r = this.db.prepare(`${SELECT_MESSAGE} WHERE m.id = ?`).get(rowId) as Row | undefined;
    if (!r) return null;
    return {
      ...summaryFrom(r), to: JSON.parse(String(r.to_json)) as string[],
      bodyText: r.body_text == null ? null : String(r.body_text), bodyHash: String(r.body_hash),
      attachments: JSON.parse(String(r.attachments_json)) as MailMessageDetail['attachments']
    };
  }

  /** Retention: drop the BODY of messages ingested before `cutoff`, keep metadata + hash. */
  purgeBodies(cutoff: number): number {
    return Number(this.db.prepare('UPDATE mail_message SET body_text = NULL WHERE body_text IS NOT NULL AND ingested_at < ?').run(cutoff).changes);
  }

  /* rules */
  listRules(): MailRule[] {
    return (this.db.prepare('SELECT * FROM mail_rule ORDER BY id').all() as Row[]).map((r) => ({
      id: n(r.id), kind: String(r.kind) as MailRuleKind, pattern: String(r.pattern), projectKey: String(r.project_key), enabled: n(r.enabled) === 1
    }));
  }
  saveRule(r: { id?: number; kind: MailRuleKind; pattern: string; projectKey: string; enabled: boolean }): number {
    if (r.id) {
      this.db.prepare('UPDATE mail_rule SET kind = ?, pattern = ?, project_key = ?, enabled = ? WHERE id = ?')
        .run(r.kind, r.pattern, r.projectKey, r.enabled ? 1 : 0, r.id);
      return r.id;
    }
    return Number(this.db.prepare('INSERT INTO mail_rule (kind, pattern, project_key, enabled) VALUES (?, ?, ?, ?)')
      .run(r.kind, r.pattern, r.projectKey, r.enabled ? 1 : 0).lastInsertRowid);
  }
  deleteRule(id: number): void { this.db.prepare('DELETE FROM mail_rule WHERE id = ?').run(id); }
}
