'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const Q = loadTs('src/shared/providerQuota.ts');
const { collectQuota } = loadTs('src/main/providerQuota.ts');

const NOW = Date.parse('2026-10-06T12:00:00Z');

test('claude usage: both windows, percent + reset; elapsed window reads 0', () => {
  const w = Q.parseClaudeUsage({
    five_hour: { utilization: 62.5, resets_at: '2026-10-06T15:00:00+00:00' },
    seven_day: { utilization: 30, resets_at: '2026-10-06T11:00:00+00:00' }, extra: 1
  }, NOW);
  assert.deepEqual(w.map((x) => [x.id, x.usedPercent, x.resetsAt]), [
    ['five_hour', 62.5, Date.parse('2026-10-06T15:00:00Z')], ['seven_day', 0, null]
  ]);
  assert.equal(Q.parseClaudeUsage({}, NOW), null);
  assert.equal(Q.parseClaudeUsage(null, NOW), null);
  assert.equal(Q.parseClaudeUsage({ five_hour: { utilization: 'x' } }, NOW), null);
});

test('codex rollout: newest rate_limits wins, null secondary skipped, epoch-seconds reset', () => {
  const line = (rl, ts) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } });
  const text = [
    line({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1791581539 }, secondary: null }, '2026-10-06T10:00:00Z'),
    'garbage line',
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    line({ primary: { used_percent: 35, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 3600 },
           secondary: { used_percent: 12, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 86400 } }, '2026-10-06T11:30:00Z'),
    line({ primary: null, secondary: null }, '2026-10-06T11:59:00Z')   // empty newest event: skipped
  ].join('\n');
  const r = Q.parseCodexRollout(text, NOW);
  assert.equal(r.windows.length, 2);
  assert.deepEqual(r.windows.map((w) => [w.id, w.usedPercent, Q.windowLabel(w)]), [['primary', 35, '5h'], ['secondary', 12, '7d']]);
  assert.equal(r.windows[0].resetsAt, (Math.floor(NOW / 1000) + 3600) * 1000);
  assert.equal(Q.parseCodexRollout('{"a":1}\n', NOW), null);
  // relative form from older builds
  const old = Q.parseCodexRollout(line({ primary: { used_percent: 9, window_minutes: 60, resets_in_seconds: 600 } }, '2026-10-06T11:55:00Z'), NOW);
  assert.equal(old.windows[0].resetsAt, Date.parse('2026-10-06T12:05:00Z'));
});

test('deepseek balance: string amounts, several currencies, junk rows dropped', () => {
  const b = Q.parseDeepseekBalance({ is_available: true, balance_infos: [
    { currency: 'cny', total_balance: '42.10', granted_balance: '10.00', topped_up_balance: '32.10' },
    { currency: 'USD', total_balance: 'nope' }, null
  ] });
  assert.deepEqual(b, [{ currency: 'CNY', total: 42.1, granted: 10, toppedUp: 32.1 }]);
  assert.equal(Q.parseDeepseekBalance({ balance_infos: [] }), null);
  assert.equal(Q.parseDeepseekBalance(undefined), null);
  assert.deepEqual(Q.spentToday({ CNY: 50 }, b), { CNY: 7.9 });
  assert.deepEqual(Q.spentToday({ CNY: 10 }, b), { CNY: 0 });   // top-up never reads as negative spend
});

test('thresholds: percent (>=) and balance (<), config repair', () => {
  const c = Q.normalizeProviderQuota({});
  assert.deepEqual([69.9, 70, 89.9, 90].map((p) => Q.percentLevel(p, c)), ['green', 'yellow', 'yellow', 'red']);
  assert.deepEqual([10, 9.99, 2, 1.99].map((p) => Q.balanceLevel(p, c)), ['green', 'yellow', 'yellow', 'red']);
  const bad = Q.normalizeProviderQuota({ yellow: 95, red: 50, balanceYellow: 1, balanceRed: 5, refreshMinutes: 0, codex: false });
  assert.deepEqual([bad.yellow, bad.red, bad.balanceYellow, bad.balanceRed, bad.refreshMinutes, bad.codex], [70, 90, 10, 2, 5, false]);
  assert.equal(Q.normalizeProviderQuota({ refreshMinutes: 1 }).refreshMinutes, 1);
});

test('labels: "Claude 62%", "DeepSeek ¥42.10", "$5.80", n/d', () => {
  const win = (p) => ({ id: 'five_hour', usedPercent: p, resetsAt: null, windowMinutes: 300 });
  assert.equal(Q.chipLabel({ provider: 'claude', kind: 'percent', ok: true, windows: [win(10), win(61.6)], fetchedAt: 0 }), 'Claude 62%');
  assert.equal(Q.chipLabel({ provider: 'deepseek', kind: 'balance', ok: true, balances: [{ currency: 'CNY', total: 42.1, granted: 0, toppedUp: 0 }], fetchedAt: 0 }), 'DeepSeek ¥42.10');
  assert.equal(Q.chipLabel({ provider: 'deepseek', kind: 'balance', ok: true, balances: [{ currency: 'USD', total: 5.8, granted: 0, toppedUp: 0 }], fetchedAt: 0 }), 'DeepSeek $5.80');
  assert.equal(Q.chipLabel({ provider: 'codex', kind: 'percent', ok: false, reason: 'x', fetchedAt: 0 }), 'Codex n/d');
  const c = Q.normalizeProviderQuota({});
  assert.equal(Q.chipLevel({ provider: 'claude', kind: 'percent', ok: true, windows: [win(10), win(95)], fetchedAt: 0 }, c), 'red');
  assert.equal(Q.chipLevel({ provider: 'deepseek', kind: 'balance', ok: true, balances: [{ currency: 'CNY', total: 1, granted: 0, toppedUp: 0 }], fetchedAt: 0 }, c), 'red');
});

function deps(over = {}) {
  let day = null;
  return {
    now: () => NOW,
    claudeUsage: async () => ({ five_hour: { utilization: 40, resets_at: '2026-10-06T15:00:00Z' } }),
    codexLimits: async () => { throw new Error('no daemon'); },
    codexRollouts: () => [],
    deepseekBalance: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '20', granted_balance: '0', topped_up_balance: '20' }] }),
    loadDay: () => day, saveDay: (v) => { day = v; },
    ...over
  };
}

test('collect: disabled providers skipped; failing sources become n/d with a secret-free reason', async () => {
  const chips = await collectQuota({ codex: false }, deps({
    claudeUsage: async () => { throw new Error('http-401'); }
  }));
  assert.deepEqual(chips.map((c) => [c.provider, c.ok, c.reason]), [['claude', false, 'http-401'], ['deepseek', true, undefined]]);
  assert.deepEqual(chips[1].spentToday, { CNY: 0 });
});

test('collect: codex from newest rollout; no data = n/d; deepseek baseline persists within the day', async () => {
  const line = JSON.stringify({ timestamp: '2026-10-06T11:00:00Z', payload: { rate_limits: { primary: { used_percent: 20, window_minutes: 300, resets_at: 1791581539 } } } });
  const d = deps({ codexRollouts: () => ['', line] });
  let chips = await collectQuota({ claude: false }, d);
  assert.equal(chips[0].provider, 'codex'); assert.equal(chips[0].ok, true); assert.equal(chips[0].windows[0].usedPercent, 20);
  d.deepseekBalance = async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '15.5', granted_balance: '0', topped_up_balance: '15.5' }] });
  chips = await collectQuota({ claude: false, codex: false }, d);
  assert.deepEqual(chips[0].spentToday, { CNY: 4.5 });
  assert.equal((await collectQuota({ claude: false, deepseek: false }, deps()))[0].ok, false);
});

test('collect: chips carry no credential material', async () => {
  const chips = await collectQuota({}, deps({ claudeUsage: async () => { throw new Error('no-claude-login'); } }));
  assert.doesNotMatch(JSON.stringify(chips), /bearer|sk-/i);
});

test('codex app-server: Pro weekly-only (primary = 10080 min, secondary null) reads 11% used', async () => {
  const result = { rateLimits: { primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1 }, secondary: null },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: NOW / 1000 + 86400 }, secondary: null } } };
  const w = Q.parseCodexRateLimits(result, NOW);
  assert.deepEqual(w.map((x) => [x.id, x.usedPercent, x.windowMinutes, x.resetsAt]), [['primary', 11, 10080, NOW + 86400000]]);
  assert.equal(Q.parseCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, NOW), null);
  const stale = JSON.stringify({ timestamp: '2026-10-01T00:00:00Z', payload: { rate_limits: { primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791581539 } } } });
  const chips = await collectQuota({ claude: false, deepseek: false }, deps({ codexLimits: async () => result, codexRollouts: () => [stale] }));
  assert.equal(chips[0].windows[0].usedPercent, 11); assert.equal(chips[0].fetchedAt, NOW);
});

test('codex: app-server down falls back to the rollout and keeps ITS timestamp (so the UI shows "updated")', async () => {
  const line = JSON.stringify({ timestamp: '2026-10-05T11:00:00Z', payload: { rate_limits: { primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791581539 } } } });
  const [c] = await collectQuota({ claude: false, deepseek: false }, deps({ codexRollouts: () => [line] }));
  assert.equal(c.fetchedAt, Date.parse('2026-10-05T11:00:00Z'));
  assert.ok(NOW - c.fetchedAt > Q.QUOTA_STALE_MS);
});

test('deepcode settings: key + https base; absent file, broken JSON, missing key, http base', () => {
  const ok = Q.parseDeepcodeSettings('{"env":{"API_KEY":" k ","BASE_URL":"https://api.deepseek.com/"}}');
  assert.deepEqual(ok, { key: 'k', base: 'https://api.deepseek.com' });
  assert.equal(Q.parseDeepcodeSettings('{"env":{"API_KEY":"k","BASE_URL":"http://evil"}}').base, null);
  assert.equal(Q.parseDeepcodeSettings(null), null);
  assert.equal(Q.parseDeepcodeSettings('{nope'), null);
  assert.equal(Q.parseDeepcodeSettings('{"env":{"BASE_URL":"https://x.y"}}'), null);
  assert.equal(Q.parseDeepcodeSettings('{"env":{"API_KEY":"  "}}'), null);
});
