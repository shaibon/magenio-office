/**
 * Provider plan-quota readings (main process only).
 *
 * READ-ONLY, quota-free: Claude's usage endpoint, Codex's local rollout logs and
 * DeepSeek's balance endpoint all report state; none of them runs a model.
 * Credentials (Claude OAuth token, DeepSeek key) are read here, used for the one
 * request and dropped — they are never returned, logged or sent to the renderer.
 * The renderer only gets `QuotaChip`s (percentages, reset times, balances).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeProviderQuota, parseClaudeUsage, parseCodexRollout, parseDeepseekBalance, spentToday,
  type ProviderQuotaConfig, type QuotaChip, type QuotaProvider
} from '../shared/providerQuota';

export interface QuotaDeps {
  now: () => number;
  /** Returns the parsed JSON body, or throws Error(reason) — reason must be secret-free. */
  claudeUsage: () => Promise<unknown>;
  codexRollouts: () => string[];
  deepseekBalance: () => Promise<unknown>;
  /** Persisted per-day DeepSeek baseline. */
  loadDay: () => { day: string; first: Record<string, number> } | null;
  saveDay: (v: { day: string; first: Record<string, number> }) => void;
}

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const na = (provider: QuotaProvider, kind: QuotaChip['kind'], reason: string, now: number): QuotaChip =>
  ({ provider, kind, ok: false, reason, fetchedAt: now });

/** One pass over the enabled providers. Never throws; a failing source is an n/d chip. */
export async function collectQuota(cfgIn: Partial<ProviderQuotaConfig> | undefined, deps: QuotaDeps): Promise<QuotaChip[]> {
  const cfg = normalizeProviderQuota(cfgIn);
  const now = deps.now();
  const chips: QuotaChip[] = [];

  if (cfg.claude) {
    try {
      const windows = parseClaudeUsage(await deps.claudeUsage(), now);
      chips.push(windows ? { provider: 'claude', kind: 'percent', ok: true, windows, fetchedAt: now }
        : na('claude', 'percent', 'unexpected-response', now));
    } catch (e) { chips.push(na('claude', 'percent', (e as Error).message || 'error', now)); }
  }

  if (cfg.codex) {
    let best: ReturnType<typeof parseCodexRollout> = null;
    try {
      for (const text of deps.codexRollouts()) {
        const r = parseCodexRollout(text, now);
        if (r && (!best || r.at > best.at)) best = r;
      }
    } catch { /* unreadable sessions dir → n/d */ }
    chips.push(best ? { provider: 'codex', kind: 'percent', ok: true, windows: best.windows, fetchedAt: best.at }
      : na('codex', 'percent', 'no-rate-limit-data', now));
  }

  if (cfg.deepseek) {
    try {
      const balances = parseDeepseekBalance(await deps.deepseekBalance());
      if (!balances) chips.push(na('deepseek', 'balance', 'unexpected-response', now));
      else {
        const day = localDay(now);
        let base = deps.loadDay();
        if (!base || base.day !== day) {
          base = { day, first: Object.fromEntries(balances.map((b) => [b.currency, b.total])) };
          deps.saveDay(base);
        }
        chips.push({ provider: 'deepseek', kind: 'balance', ok: true, balances, spentToday: spentToday(base.first, balances), fetchedAt: now });
      }
    } catch (e) { chips.push(na('deepseek', 'balance', (e as Error).message || 'error', now)); }
  }
  return chips;
}

// ─── real sources ───────────────────────────────────────────────────────────

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error('network'); }
  if (!res.ok) throw new Error(`http-${res.status}`);
  try { return await res.json(); } catch { throw new Error('unexpected-response'); }
}

const run = (cmd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? null : out)));

/** The Claude Code OAuth access token: env override, then the macOS keychain item
 *  Claude Code itself writes, then its credentials file. Not refreshed here (a
 *  refresh rotates the token Claude Code holds) — an expired token is just n/d. */
async function claudeToken(): Promise<string> {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (env) return env;
  let raw: string | null = null;
  if (process.platform === 'darwin') raw = await run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
  if (!raw) {
    const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
    try { raw = readFileSync(file, 'utf8'); } catch { raw = null; }
  }
  if (!raw) throw new Error('no-claude-login');
  try {
    const o = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
    if (typeof o?.accessToken !== 'string' || !o.accessToken) throw new Error('no-claude-login');
    if (typeof o.expiresAt === 'number' && o.expiresAt <= Date.now()) throw new Error('claude-login-expired');
    return o.accessToken;
  } catch (e) {
    throw new Error((e as Error).message.startsWith('claude') || (e as Error).message.startsWith('no-') ? (e as Error).message : 'no-claude-login');
  }
}

/** Newest few Codex rollout files' tails (rate_limits ride on token_count events, so the tail suffices). */
function codexRollouts(): string[] {
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  if (!existsSync(root)) return [];
  const files: { p: string; m: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[] = [];
    try { names = readdirSync(dir).sort().reverse(); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      if (depth < 3) { if (files.length < 5) walk(p, depth + 1); }
      else if (n.endsWith('.jsonl')) { try { files.push({ p, m: statSync(p).mtimeMs }); } catch { /* gone */ } }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.m - a.m).slice(0, 5).map(({ p }) => {
    const TAIL = 512 * 1024;
    let fd = -1;
    try {
      fd = openSync(p, 'r');
      const size = statSync(p).size, len = Math.min(size, TAIL), buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } catch { return ''; } finally { if (fd >= 0) closeSync(fd); }
  });
}

function deepseekKey(): string | null {
  const k = process.env.DEEPSEEK_API_KEY?.trim();
  return k || null;
}

export function realDeps(userDataDir: string, loginShellEnv: (name: string) => string | null): QuotaDeps {
  const dayFile = join(userDataDir, 'provider-quota-day.json');
  return {
    now: Date.now,
    claudeUsage: async () => getJson('https://api.anthropic.com/api/oauth/usage', {
      authorization: `Bearer ${await claudeToken()}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json'
    }),
    codexRollouts,
    deepseekBalance: async () => {
      const key = deepseekKey() ?? loginShellEnv('DEEPSEEK_API_KEY');
      if (!key) throw new Error('no-deepseek-key');
      return getJson('https://api.deepseek.com/user/balance', { authorization: `Bearer ${key}`, accept: 'application/json' });
    },
    loadDay: () => { try { return JSON.parse(readFileSync(dayFile, 'utf8')); } catch { return null; } },
    saveDay: (v) => { try { writeFileSync(dayFile, JSON.stringify(v)); } catch { /* best effort */ } }
  };
}
