/**
 * The mail-poll tick: fetch new mail per account, ingest it, route it, and move
 * the cursor. READ-ONLY by construction: it holds a MailProvider (list/fetch only)
 * and a store, and has no way to send, draft or alter a mailbox.
 *
 * Every dependency is injected, so the tests drive it with a fake provider and an
 * in-memory database and never touch a mailbox.
 */
import {
  classificationForHandoff, classifyPrompt, mailBackoffMs, parseClassification, plainBody, resolveThreadId, routeByModelHint, routeByRules, wrapUntrusted,
  type Classification, type RawMail, type Route
} from '../../shared/mail';
import type { MailAccountRow, MailStore } from './store';
import type { MailProviderFactory } from './provider';

export interface MailPollDeps {
  store: MailStore;
  /** Decrypts the account's secret. MAIN-INTERNAL; undefined when absent/undecryptable. */
  getSecret: (secretRef: string) => string | undefined;
  makeProvider: MailProviderFactory;
  /** One call to the LOCAL mail agent; returns its text or null. Absent (no local
   *  model configured/reachable) = rules-only routing and no summary. There is no
   *  other model in this pipeline and never a cloud fallback. */
  classify?: (prompt: string) => Promise<string | null>;
  /** Post a routed mail's summary to the hive (see handoffMessage for what crosses). */
  handoff?: (h: { mailId: number; projectKey: string; fromDomain: string; classification: Classification; summaryWithheld: boolean }) => void;
  /** Jira project keys the Boss has bound (the only keys a mail may route to). */
  knownProjectKeys: () => string[];
  pollIntervalMs: () => number;
  retentionDays: () => number;
  log: (event: Record<string, unknown>) => void;
  now?: () => number;
  model?: string;
}

export interface AccountPollResult { accountId: string; ingested: number; skipped: number; error?: string }

const BATCH = 50;

/** Strip the credential (and anything shaped like one) out of an error before it is stored or logged. */
export function scrubError(e: unknown, secret: string | undefined): string {
  let msg = e instanceof Error ? e.message : String(e);
  if (secret) msg = msg.split(secret).join('[redacted]');
  return msg.replace(/\s+/g, ' ').slice(0, 300);
}

async function ingestOne(deps: MailPollDeps, acct: MailAccountRow, m: RawMail, keys: string[], now: number): Promise<boolean> {
  const { store } = deps;
  const body = plainBody(m);
  const threadId = resolveThreadId(m, (id) => store.threadOf(acct.id, id));
  const rowId = store.insertMessage(acct.id, m, { threadId, body, now });
  if (rowId === null) return false; // already ingested: dedup by Message-ID

  let route: Route | null = routeByRules({ fromAddress: m.from.address, subject: m.subject, body }, store.listRules(), keys);
  let classification: Classification | null = null;
  let category: string = 'other';
  let urgency: string = 'normal';

  if (m.automated) {
    // Bulk mail is not worth a model call.
    category = 'newsletter'; urgency = 'low';
  } else if (deps.classify) {
    // Run for every mail, not only undecided ones: the summary is the point. Rules
    // still win the routing; the model's hint is only the fallback.
    try {
      const reply = await deps.classify(classifyPrompt(wrapUntrusted({ from: `${m.from.name} <${m.from.address}>`, subject: m.subject, body }), keys));
      classification = parseClassification(reply);
    } catch { classification = null; }
    if (classification) {
      category = classification.category; urgency = classification.urgency;
      route = route ?? routeByModelHint(classification, keys);
    }
  }
  store.saveTriage(rowId, { category, urgency, route, classification, model: classification ? deps.model ?? null : null, at: now });
  // Only a summary ever leaves; a mail with no summary (rules-only mode) is not handed off.
  if (route && classification && deps.handoff) {
    // What the local model wrote is free text and may echo the mail: names are masked
    // and a quoting summary is withheld entirely before anything leaves.
    const safe = classificationForHandoff(classification, { subject: m.subject, body, fromName: m.from.name, fromAddress: m.from.address, to: m.to });
    try { deps.handoff({ mailId: rowId, projectKey: route.projectKey, fromDomain: m.from.address.split('@')[1] ?? '', ...safe, summaryWithheld: safe.summaryWithheld }); } catch { /* the triage is already stored */ }
  }
  return true;
}

export async function pollAccount(deps: MailPollDeps, acct: MailAccountRow): Promise<AccountPollResult> {
  const now = (deps.now ?? Date.now)();
  const base = deps.pollIntervalMs();
  const result: AccountPollResult = { accountId: acct.id, ingested: 0, skipped: 0 };
  // Fail closed: no credential, no connection.
  const secret = deps.getSecret(acct.secretRef);
  if (!secret) {
    const error = 'no stored credentials for this account';
    deps.store.markFailed(acct.id, { error, at: now, nextPollAt: now + mailBackoffMs(acct.errorCount + 1, base) });
    return { ...result, error };
  }
  const provider = deps.makeProvider({ host: acct.host, port: acct.port, username: acct.username, mailbox: acct.mailbox }, secret);
  try {
    const keys = deps.knownProjectKeys();
    // A changed UIDVALIDITY means the old UIDs mean nothing: start over (Message-ID dedup makes that safe).
    let lastUid = acct.lastUid;
    const first = await provider.fetchSince(lastUid, BATCH);
    if (acct.uidValidity !== null && first.uidValidity !== null && first.uidValidity !== acct.uidValidity) {
      lastUid = 0;
    }
    const fetched = lastUid === acct.lastUid ? first : await provider.fetchSince(lastUid, BATCH);
    for (const m of fetched.messages) {
      if (await ingestOne(deps, acct, m, keys, now)) result.ingested++; else result.skipped++;
      // Per message, so a failure halfway leaves everything before it done and never redone.
      deps.store.setCursor(acct.id, Math.max(lastUid, m.uid));
      lastUid = Math.max(lastUid, m.uid);
    }
    deps.store.markPolled(acct.id, { lastUid, uidValidity: fetched.uidValidity ?? acct.uidValidity, at: now, nextPollAt: now + base });
    return result;
  } catch (e) {
    const error = scrubError(e, secret);
    deps.store.markFailed(acct.id, { error, at: now, nextPollAt: now + mailBackoffMs(acct.errorCount + 1, base) });
    return { ...result, error };
  } finally {
    try { await provider.close(); } catch { /* best effort */ }
  }
}

/** One tick over every account that is due (or all of them with `force`). */
export async function runMailPoll(deps: MailPollDeps, opts: { force?: boolean } = {}): Promise<AccountPollResult[]> {
  const now = (deps.now ?? Date.now)();
  const out: AccountPollResult[] = [];
  for (const acct of deps.store.listAccounts()) {
    if (!opts.force && acct.nextPollAt > now) continue;
    const r = await pollAccount(deps, acct);
    deps.log({ kind: 'mail-poll', account: acct.id, ingested: r.ingested, skipped: r.skipped, ...(r.error ? { error: r.error } : {}) });
    out.push(r);
  }
  const days = deps.retentionDays();
  if (days > 0) {
    const purged = deps.store.purgeBodies(now - days * 86_400_000);
    if (purged) deps.log({ kind: 'mail-retention', purged });
  }
  return out;
}
