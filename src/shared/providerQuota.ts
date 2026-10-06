/**
 * Provider plan-quota chips — pure model, parsers and thresholds.
 *
 * Framework-agnostic (no fs, no electron): main fetches, this file parses and
 * classifies, the renderer only ever receives the resulting `QuotaChip`s
 * (percentages, reset times, balances — never a token or key).
 *
 * Two chip kinds so any provider fits the same pill:
 *   - 'percent': subscription windows (Claude 5h/weekly, Codex primary/secondary)
 *   - 'balance': prepaid credit in a currency (DeepSeek)
 */

export type QuotaProvider = 'claude' | 'codex' | 'deepseek';
export const QUOTA_PROVIDERS: readonly QuotaProvider[] = ['claude', 'codex', 'deepseek'];
export type QuotaLevel = 'green' | 'yellow' | 'red';

export interface QuotaWindow {
  /** Window length when the source says it (Codex), else implied by `id`. */
  windowMinutes: number | null;
  id: 'five_hour' | 'seven_day' | 'primary' | 'secondary';
  usedPercent: number;
  /** Epoch ms, or null when unknown / already elapsed. */
  resetsAt: number | null;
}

export interface QuotaBalance {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

export interface QuotaChip {
  provider: QuotaProvider;
  kind: 'percent' | 'balance';
  /** False = show "n/d" with `reason` as the tooltip. Never carries secrets. */
  ok: boolean;
  reason?: string;
  windows?: QuotaWindow[];
  balances?: QuotaBalance[];
  /** DeepSeek: balance drop since the first reading of the local day, per currency. */
  spentToday?: Record<string, number>;
  /** Epoch ms of the reading. */
  fetchedAt: number;
}

export interface ProviderQuotaConfig {
  claude: boolean;
  codex: boolean;
  deepseek: boolean;
  /** Percent used at/above which a percent chip turns yellow / red. */
  yellow: number;
  red: number;
  /** Balance (in its own currency) BELOW which a balance chip turns yellow / red. */
  balanceYellow: number;
  balanceRed: number;
  refreshMinutes: number;
}

export const DEFAULT_PROVIDER_QUOTA: ProviderQuotaConfig = {
  claude: true, codex: true, deepseek: true,
  yellow: 70, red: 90, balanceYellow: 10, balanceRed: 2, refreshMinutes: 5
};

const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;

/** Fills defaults and repairs impossible combinations (red must be above yellow
 *  for percent, below it for balance). Never throws. */
export function normalizeProviderQuota(raw: Partial<ProviderQuotaConfig> | undefined): ProviderQuotaConfig {
  const r = raw ?? {};
  const d = DEFAULT_PROVIDER_QUOTA;
  let yellow = num(r.yellow, 1, 100, d.yellow);
  let red = num(r.red, 1, 100, d.red);
  if (red <= yellow) { yellow = d.yellow; red = d.red; }
  let balanceYellow = num(r.balanceYellow, 0, 1e9, d.balanceYellow);
  let balanceRed = num(r.balanceRed, 0, 1e9, d.balanceRed);
  if (balanceRed >= balanceYellow) { balanceYellow = d.balanceYellow; balanceRed = d.balanceRed; }
  return {
    claude: r.claude !== false, codex: r.codex !== false, deepseek: r.deepseek !== false,
    yellow, red, balanceYellow, balanceRed,
    refreshMinutes: Math.round(num(r.refreshMinutes, 1, 1440, d.refreshMinutes))
  };
}

export function percentLevel(usedPercent: number, cfg: Pick<ProviderQuotaConfig, 'yellow' | 'red'>): QuotaLevel {
  return usedPercent >= cfg.red ? 'red' : usedPercent >= cfg.yellow ? 'yellow' : 'green';
}

export function balanceLevel(total: number, cfg: Pick<ProviderQuotaConfig, 'balanceYellow' | 'balanceRed'>): QuotaLevel {
  return total < cfg.balanceRed ? 'red' : total < cfg.balanceYellow ? 'yellow' : 'green';
}

/** Worst level of a chip (green when n/d). */
export function chipLevel(chip: QuotaChip, cfg: ProviderQuotaConfig): QuotaLevel {
  if (!chip.ok) return 'green';
  if (chip.kind === 'balance') {
    const first = chip.balances?.[0];
    return first ? balanceLevel(first.total, cfg) : 'green';
  }
  const worst = Math.max(0, ...(chip.windows ?? []).map((w) => w.usedPercent));
  return percentLevel(worst, cfg);
}

const SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€' };

export function formatMoney(amount: number, currency: string): string {
  const c = currency.toUpperCase();
  const n = amount.toFixed(2);
  return SYMBOLS[c] ? `${SYMBOLS[c]}${n}` : `${c} ${n}`;
}

const NAMES: Record<QuotaProvider, string> = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };

/** The pill text: "Claude 62%", "DeepSeek ¥42.10", "Codex n/d". */
export function chipLabel(chip: QuotaChip): string {
  const name = NAMES[chip.provider];
  if (!chip.ok) return `${name} n/d`;
  if (chip.kind === 'balance') {
    const b = chip.balances?.[0];
    return b ? `${name} ${formatMoney(b.total, b.currency)}` : `${name} n/d`;
  }
  const worst = Math.max(0, ...(chip.windows ?? []).map((w) => w.usedPercent));
  return `${name} ${Math.round(worst)}%`;
}

// ─── parsers ────────────────────────────────────────────────────────────────

const pct = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;

function isoMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Claude Code's OAuth usage endpoint (the one behind /usage):
 *  `{ five_hour: {utilization, resets_at}, seven_day: {...}, ... }`, utilization in percent.
 *  Returns null when neither window is present. */
export function parseClaudeUsage(json: unknown, now = Date.now()): QuotaWindow[] | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const out: QuotaWindow[] = [];
  for (const [key, id, minutes] of [['five_hour', 'five_hour', 300], ['seven_day', 'seven_day', 10080]] as const) {
    const w = o[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    const used = pct(w?.utilization);
    if (used === null) continue;
    const resetsAt = isoMs(w?.resets_at);
    out.push(elapsed({ id, windowMinutes: minutes, usedPercent: used, resetsAt }, now));
  }
  return out.length ? out : null;
}

/** A window whose reset time has passed has reset: report 0% rather than stale usage. */
function elapsed(w: QuotaWindow, now: number): QuotaWindow {
  return w.resetsAt !== null && w.resetsAt <= now ? { ...w, usedPercent: 0, resetsAt: null } : w;
}

/** Newest `rate_limits` event in a Codex rollout (JSONL text). Scans from the end;
 *  `primary`/`secondary` may each be null (a plan with a single window).
 *  `resets_at` is epoch seconds; older builds wrote `resets_in_seconds` relative to the line. */
export function parseCodexRollout(text: string, now = Date.now()): { windows: QuotaWindow[]; at: number } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let ev: { timestamp?: unknown; payload?: { rate_limits?: unknown }; rate_limits?: unknown };
    try { ev = JSON.parse(line); } catch { continue; }
    const rl = (ev.payload?.rate_limits ?? ev.rate_limits) as Record<string, unknown> | null | undefined;
    if (!rl || typeof rl !== 'object') continue;
    const at = isoMs(ev.timestamp) ?? now;
    const windows: QuotaWindow[] = [];
    for (const id of ['primary', 'secondary'] as const) {
      const w = rl[id] as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown; resets_in_seconds?: unknown } | null | undefined;
      const used = pct(w?.used_percent);
      if (used === null) continue;
      let resetsAt: number | null = null;
      if (typeof w?.resets_at === 'number') resetsAt = w.resets_at * 1000;
      else if (typeof w?.resets_in_seconds === 'number') resetsAt = at + w.resets_in_seconds * 1000;
      windows.push(elapsed({
        id, usedPercent: used, resetsAt,
        windowMinutes: typeof w?.window_minutes === 'number' ? w.window_minutes : null
      }, now));
    }
    if (windows.length) return { windows, at };
  }
  return null;
}

/** GET https://api.deepseek.com/user/balance →
 *  `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`
 *  (amounts are decimal strings). Null when no usable balance row. */
export function parseDeepseekBalance(json: unknown): QuotaBalance[] | null {
  const infos = (json as { balance_infos?: unknown } | null)?.balance_infos;
  if (!Array.isArray(infos)) return null;
  const out: QuotaBalance[] = [];
  for (const r of infos) {
    const row = r as Record<string, unknown> | null;
    const total = Number(row?.total_balance);
    if (!row || typeof row.currency !== 'string' || !Number.isFinite(total)) continue;
    const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
    out.push({ currency: row.currency.toUpperCase(), total, granted: n(row.granted_balance), toppedUp: n(row.topped_up_balance) });
  }
  return out.length ? out : null;
}

/** Balance drop since the day's first reading, per currency (never negative: a top-up reads as 0). */
export function spentToday(first: Record<string, number>, current: readonly QuotaBalance[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of current) {
    if (typeof first[b.currency] === 'number') out[b.currency] = Math.max(0, +(first[b.currency] - b.total).toFixed(2));
  }
  return out;
}

/** "5h", "7d", "90m" — from the source's window length, or implied by the id. */
export function windowLabel(w: Pick<QuotaWindow, 'id' | 'windowMinutes'>): string {
  const m = w.windowMinutes ?? (w.id === 'five_hour' ? 300 : w.id === 'seven_day' ? 10080 : null);
  if (m === null) return w.id;
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440}d`;
  return m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}
