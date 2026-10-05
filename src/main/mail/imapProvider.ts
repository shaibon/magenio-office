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
import { MAX_TEXT_PART_BYTES, parseHeaderBlock, planParts, type AttachmentMeta, type BodyNode, type TextPart } from './mimePlan';

interface FetchedMessage {
  uid: number;
  envelope?: {
    date?: Date; subject?: string; messageId?: string; inReplyTo?: string;
    from?: { name?: string; address?: string }[]; to?: { address?: string }[];
  };
  bodyStructure?: BodyNode;
  headers?: Buffer;
}
interface ImapFlowLike {
  connect(): Promise<void>;
  getMailboxLock(path: string, opts: { readOnly: boolean }): Promise<{ release(): void }>;
  mailbox: { uidValidity?: bigint | number } | false;
  fetch(range: string, query: Record<string, unknown>, opts: { uid: boolean }): AsyncIterable<FetchedMessage>;
  download(range: string, part: string, opts: { uid: boolean; maxBytes: number }): Promise<{ content: AsyncIterable<Buffer> }>;
  logout(): Promise<void>;
  close(): void;
  on(ev: string, fn: (e: unknown) => void): void;
}
interface ParsedLike { text?: string; html?: string | false }

/** Seams for tests; production loads the real libraries lazily. */
export interface ImapDeps {
  ImapFlow?: new (o: Record<string, unknown>) => ImapFlowLike;
  simpleParser?: (s: Buffer) => Promise<ParsedLike>;
}

const HEADERS = ['references', 'list-unsubscribe', 'precedence', 'auto-submitted'];

export function createImapProvider(conn: MailAccountConn, password: string, deps: ImapDeps = {}): MailProvider {
  let client: ImapFlowLike | null = null;

  const open = async (): Promise<ImapFlowLike> => {
    if (client) return client;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ImapFlow = deps.ImapFlow ?? (require('imapflow') as { ImapFlow: NonNullable<ImapDeps['ImapFlow']> }).ImapFlow;
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

  /** Download ONE text part (decoded, size-capped) and let mailparser apply its charset. */
  const readText = async (c: ImapFlowLike, uid: number, t: TextPart, parse: NonNullable<ImapDeps['simpleParser']>): Promise<string> => {
    const dl = await c.download(String(uid), t.part, { uid: true, maxBytes: MAX_TEXT_PART_BYTES });
    const chunks: Buffer[] = [];
    for await (const ch of dl.content) chunks.push(ch);
    const wrapper = Buffer.concat([
      Buffer.from(`Content-Type: ${t.type}; charset="${t.charset.replace(/[^\w.-]/g, '')}"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`),
      ...chunks
    ]);
    const p = await parse(wrapper);
    return t.type === 'text/html' ? (typeof p.html === 'string' ? p.html : p.text ?? '') : p.text ?? '';
  };

  return {
    async fetchSince(lastUid, limit): Promise<FetchResult> {
      const c = await open();
      const lock = await c.getMailboxLock(conn.mailbox, { readOnly: true });
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const parse = deps.simpleParser ?? (require('mailparser') as { simpleParser: NonNullable<ImapDeps['simpleParser']> }).simpleParser;
        const uidValidity = c.mailbox ? Number(c.mailbox.uidValidity ?? 0) || null : null;
        // Structure and headers only: the message source (and so any attachment
        // bytes) is never requested. Text parts are downloaded one by one below.
        const heads: FetchedMessage[] = [];
        for await (const m of c.fetch(`${lastUid + 1}:*`, { uid: true, envelope: true, bodyStructure: true, headers: HEADERS }, { uid: true })) {
          // `N:*` always includes the newest message even when it is <= lastUid.
          if (m.uid > lastUid) heads.push(m);
        }
        heads.sort((a, b) => a.uid - b.uid);
        const out: RawMail[] = [];
        for (const m of heads.slice(0, limit)) {
          const plan = planParts(m.bodyStructure);
          let text: string | undefined; let html: string | undefined;
          for (const t of plan.text) {
            const body = await readText(c, m.uid, t, parse);
            if (t.type === 'text/html') html ??= body; else text ??= body;
          }
          out.push(toRaw(m, plan.attachments, text, html));
        }
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

function toRaw(m: FetchedMessage, attachments: AttachmentMeta[], text?: string, html?: string): RawMail {
  const h = parseHeaderBlock(m.headers);
  const e = m.envelope ?? {};
  const prec = (h.get('precedence') ?? '').toLowerCase();
  const auto = h.get('auto-submitted');
  const f = e.from?.[0];
  return {
    uid: m.uid,
    messageId: normalizeMessageId(e.messageId) || `uid-${m.uid}@no-message-id`,
    inReplyTo: e.inReplyTo,
    references: (h.get('references') ?? '').split(/\s+/).filter(Boolean),
    from: { name: f?.name ?? '', address: (f?.address ?? '').toLowerCase() },
    to: (e.to ?? []).map((a) => a.address ?? '').filter(Boolean),
    subject: e.subject ?? '',
    date: e.date instanceof Date && !isNaN(e.date.getTime()) ? e.date.getTime() : Date.now(),
    text, html,
    automated: h.has('list-unsubscribe') || prec === 'bulk' || prec === 'list' || (!!auto && auto.toLowerCase() !== 'no'),
    attachments
  };
}
