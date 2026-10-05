/**
 * Mail area — view logic that needs no DOM: the sidebar counts, the list
 * selection and the "why was it routed there" line. Kept apart from the
 * components so it can be tested; nothing here touches the mailbox.
 */

export interface ViewTriage {
  category: string;
  urgency: string;
  projectKey: string | null;
  via: string;
  confidence: number | null;
}
export interface ViewMessage {
  id: number;
  receivedAt: number;
  triage: ViewTriage | null;
}

/** What the left column has selected: everything, the unassigned bucket, or one project. */
export type MailSelection = { kind: 'all' } | { kind: 'unassigned' } | { kind: 'project'; key: string };

/** A message with no triage yet counts as unassigned: it has no project. */
const projectOf = (m: ViewMessage): string | null => m.triage?.projectKey ?? null;

export function mailCounts(msgs: ViewMessage[]): { total: number; unassigned: number; byProject: [string, number][] } {
  const by = new Map<string, number>();
  let unassigned = 0;
  for (const m of msgs) {
    const p = projectOf(m);
    if (p === null) unassigned++;
    else by.set(p, (by.get(p) ?? 0) + 1);
  }
  return {
    total: msgs.length,
    unassigned,
    byProject: [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  };
}

export function selectMessages<T extends ViewMessage>(msgs: T[], sel: MailSelection): T[] {
  if (sel.kind === 'all') return msgs;
  if (sel.kind === 'unassigned') return msgs.filter((m) => projectOf(m) === null);
  return msgs.filter((m) => projectOf(m) === sel.key);
}

/** Routing explanation as i18n key + params, so the component only translates it. */
export function triageReason(t: ViewTriage | null): { key: string; pct?: number } {
  if (!t) return { key: 'mail.reason.pending' };
  const pct = t.confidence === null ? undefined : Math.round(t.confidence * 100);
  switch (t.via) {
    case 'rule': return { key: 'mail.reason.rule' };
    case 'jira-key': return { key: 'mail.reason.jiraKey' };
    case 'manual': return { key: 'mail.reason.manual' };
    case 'model': return pct === undefined ? { key: 'mail.reason.modelNoConf' } : { key: 'mail.reason.model', pct };
    default: return { key: 'mail.reason.none' };
  }
}

/** Compact age: "now", "5m", "3h", "2d". */
export function ageLabel(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/* ─────────────────────────────── paging ─────────────────────────────── */

/** Messages per request; the backend caps a page at 200. */
export const MAIL_PAGE_SIZE = 200;

/** Add a page to what is already loaded: de-duplicated by id, newest first. A
 *  refresh of the first page therefore never drops older pages already fetched. */
export function mergePage<T extends ViewMessage>(loaded: T[], page: T[]): T[] {
  const byId = new Map<number, T>();
  for (const m of loaded) byId.set(m.id, m);
  for (const m of page) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => b.receivedAt - a.receivedAt || b.id - a.id);
}

/** `before` cursor for the next page: the oldest loaded message. The backend
 *  compares strictly (`received_at < before`), so mail sharing the exact
 *  millisecond of a page boundary would be skipped — accepted, it needs two
 *  messages in the same ms right at the 200th. */
export function nextCursor(loaded: ViewMessage[]): number | undefined {
  return loaded.length ? Math.min(...loaded.map((m) => m.receivedAt)) : undefined;
}

/** A page this full may be followed by another. */
export const pageMayHaveMore = (page: unknown[]): boolean => page.length >= MAIL_PAGE_SIZE;

/** Counts only cover what is loaded, so say so while older mail is still on the server. */
export const countLabel = (n: number, hasMore: boolean): string => (hasMore ? `${n}+` : String(n));
