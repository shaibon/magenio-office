/**
 * IMAP adapter (read-only, TLS only), on `imapflow` + `mailparser`.
 *
 * Both libraries are loaded lazily and typed locally, so nothing else in the app
 * pays for them and a missing install fails one poll instead of the app. The
 * mailbox is opened read-only and bodies are fetched without setting \Seen;
 * attachments are described, never downloaded.
 */
import type { MailAccountConn, MailProvider, FetchResult } from './provider';
import { normalizeMessageId, type RawMail } from '../../shared/mail';

interface ImapFlowLike {
  connect(): Promise<void>;
  getMailboxLock(path: string, opts: { readOnly: boolean }): Promise<{ release(): void }>;
  mailbox: { uidValidity?: bigint | number } | false;
  fetch(range: string, query: Record<string, boolean>, opts: { uid: boolean }): AsyncIterable<{ uid: number; source?: Buffer }>;
  logout(): Promise<void>;
  close(): void;
  on(ev: string, fn: (e: unknown) => void): void;
}
interface ParsedLike {
  messageId?: string; inReplyTo?: string; references?: string | string[]; subject?: string; date?: Date;
  from?: { value: { name?: string; address?: string }[] };
  to?: { value: { address?: string }[] } | { value: { address?: string }[] }[];
  text?: string; html?: string | false;
  headers?: Map<string, unknown>;
  attachments?: { filename?: string; contentType?: string; size?: number }[];
}

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export function createImapProvider(conn: MailAccountConn, password: string): MailProvider {
  let client: ImapFlowLike | null = null;

  const open = async (): Promise<ImapFlowLike> => {
    if (client) return client;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ImapFlow } = require('imapflow') as { ImapFlow: new (o: Record<string, unknown>) => ImapFlowLike };
    const c = new ImapFlow({
      host: conn.host, port: conn.port,
      secure: true,                               // TLS from the first byte, no STARTTLS downgrade
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: conn.username, pass: password },
      logger: false,                              // the library logs commands, credentials included
      disableAutoIdle: true
    });
    c.on('error', () => { /* surfaced by the awaited call; never log the raw event */ });
    await c.connect();
    client = c;
    return c;
  };

  return {
    async fetchSince(lastUid, limit): Promise<FetchResult> {
      const c = await open();
      const lock = await c.getMailboxLock(conn.mailbox, { readOnly: true });
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { simpleParser } = require('mailparser') as { simpleParser: (s: Buffer) => Promise<ParsedLike> };
        const uidValidity = c.mailbox ? Number(c.mailbox.uidValidity ?? 0) || null : null;
        const out: RawMail[] = [];
        for await (const m of c.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          // `N:*` always includes the newest message even when it is <= lastUid.
          if (m.uid <= lastUid || !m.source) continue;
          if (m.source.length > MAX_SOURCE_BYTES) { out.push(oversized(m.uid)); continue; }
          out.push(toRaw(m.uid, await simpleParser(m.source)));
          if (out.length >= limit) break;
        }
        out.sort((a, b) => a.uid - b.uid);
        return { messages: out, uidValidity };
      } finally {
        lock.release();
      }
    },
    async close(): Promise<void> {
      const c = client;
      client = null;
      if (!c) return;
      try { await c.logout(); } catch { try { c.close(); } catch { /* already gone */ } }
    }
  };
}

const addrList = (v: ParsedLike['to']): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.value.map((a) => a.address ?? '').filter(Boolean));

function toRaw(uid: number, p: ParsedLike): RawMail {
  const h = p.headers;
  const refs = typeof p.references === 'string' ? p.references.split(/\s+/) : p.references ?? [];
  const prec = String(h?.get('precedence') ?? '').toLowerCase();
  const f = p.from?.value[0];
  return {
    uid,
    messageId: normalizeMessageId(p.messageId) || `uid-${uid}@no-message-id`,
    inReplyTo: p.inReplyTo,
    references: refs.filter(Boolean),
    from: { name: f?.name ?? '', address: (f?.address ?? '').toLowerCase() },
    to: addrList(p.to),
    subject: p.subject ?? '',
    date: p.date instanceof Date && !isNaN(p.date.getTime()) ? p.date.getTime() : Date.now(),
    text: p.text,
    html: typeof p.html === 'string' ? p.html : undefined,
    automated: !!h?.get('list-unsubscribe') || prec === 'bulk' || prec === 'list' || (!!h?.get('auto-submitted') && String(h.get('auto-submitted')) !== 'no'),
    attachments: (p.attachments ?? []).map((a) => ({ filename: a.filename ?? '', contentType: a.contentType ?? '', size: a.size ?? 0 }))
  };
}

/** A message over the size cap is recorded by uid so the cursor moves past it. */
function oversized(uid: number): RawMail {
  return {
    uid, messageId: `uid-${uid}@oversized`, references: [], from: { name: '', address: '' }, to: [],
    subject: '(message too large to ingest)', date: Date.now(), automated: false, attachments: []
  };
}
