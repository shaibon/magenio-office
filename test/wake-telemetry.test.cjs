'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fleetActivity } = loadTs('src/shared/fleetActivity.ts');
const { deepcodeActivity, lastToolInJsonl, deepcodeProjectCode } = loadTs('src/main/deepcodeSession.ts');
const os = require('node:os');
const { createHibernatedStore } = loadTs('src/renderer/src/hooks/hibernatedStore.ts');

const tick = () => new Promise((r) => setImmediate(r));

test('a missed wake event cannot leave the HIBERNATED badge up: the periodic refresh drops it', async () => {
  const state = { pam: true };
  let cb;
  const bridge = {
    hibernateState: async (id) => ({ hibernated: state[id] }),
    onHiveAgentHibernation: (f) => { cb = f; return () => { cb = undefined; }; }
  };
  const store = createHibernatedStore(() => bridge);
  const off = store.subscribe(() => {});
  store.seed(['pam']); await tick();
  assert.equal(store.snapshot().has('pam'), true);
  state.pam = false; // main woke it; the event never reached this window
  store.refresh(); await tick();
  assert.equal(store.snapshot().has('pam'), false);
  off();
});

test('a refresh reply older than a newer event is discarded', async () => {
  let release; let cb;
  const bridge = {
    hibernateState: (id) => new Promise((res) => { release = () => res({ hibernated: false }); }),
    onHiveAgentHibernation: (f) => { cb = f; return () => {}; }
  };
  const store = createHibernatedStore(() => bridge);
  store.subscribe(() => {});
  cb({ id: 'pam', hibernated: true });
  store.refresh();               // asks main (reply will say awake)
  cb({ id: 'pam', hibernated: true }); // a newer event says asleep again
  release(); await tick();
  assert.equal(store.snapshot().has('pam'), true);
});

test('wiring: hibernation events reach every window; both fleet snapshots use fleetActivity with the DeepCode session files', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(main, /for \(const w of allWindows\) \{ if \(!w\.isDestroyed\(\) && !w\.webContents\.isDestroyed\(\)\) w\.webContents\.send\('hive:agentHibernation'/);
  assert.equal((main.match(/fleetActivity\(now, \{ usageTs: u\?\.ts[^\n]*deepcode: deepcodeActivityFor\(id, a\) \}\)/g) || []).length, 2);
  assert.doesNotMatch(main, /ptyOutputAtFor|outputCountsAsActivity/, 'no terminal-output heuristic');
});

test('overlapping refreshes: the older reply arriving last cannot flip the badge back', async () => {
  const pending = [];
  const bridge = {
    hibernateState: () => new Promise((res) => pending.push(res)),
    onHiveAgentHibernation: (f) => { f({ id: 'pam', hibernated: true }); return () => {}; }
  };
  const store = createHibernatedStore(() => bridge);
  store.subscribe(() => {});
  assert.equal(store.snapshot().has('pam'), true);
  store.refresh(); store.refresh();
  pending[1]({ hibernated: false }); await tick();
  assert.equal(store.snapshot().has('pam'), false);
  pending[0]({ hibernated: true }); await tick();
  assert.equal(store.snapshot().has('pam'), false, 'stale reply discarded');
});


const SID = 'cccccccc-3333-4333-8333-cccccccccccc';
function fixture(opts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-act-'));
  const cwd = '/Users/x/wt/andy-9';
  const dir = path.join(home, '.deepcode', 'projects', deepcodeProjectCode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions-index.json'), JSON.stringify({
    version: 1, entries: [{ id: SID, status: opts.status, updateTime: opts.updateTime, usage: { total_tokens: opts.tokens } }]
  }));
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), opts.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { home, cwd, dir };
}

test('DeepCode activity comes from its own session files DURING the turn: status, tokens, last tool, updateTime', () => {
  const f = fixture({
    status: 'processing', updateTime: '2026-11-02T01:22:00.000Z', tokens: 4242,
    rows: [
      { role: 'user', content: 'go' },
      { role: 'tool', meta: { function: { name: 'read_file' } } },
      { role: 'assistant', messageParams: { tool_calls: [] } },
      { role: 'tool', meta: { function: { name: 'bash' } } },
      { role: 'assistant' }
    ]
  });
  try {
    const a = deepcodeActivity(f.cwd, f.home, SID);
    assert.deepEqual({ ...a }, { status: 'processing', updatedAt: Date.parse('2026-11-02T01:22:00.000Z'), totalTokens: 4242, lastTool: 'bash' });
    // and the fleet fields come out of it instead of tokens 0 / lastTool null / lastActive null
    const now = Date.parse('2026-11-02T01:22:30.000Z');
    assert.deepEqual({ ...fleetActivity(now, { deepcode: a }) }, { lastActiveSecAgo: 30, lastTool: 'bash', tokens: 4242 });
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('telemetry still wins when present; no files and no telemetry stays null (nothing inferred)', () => {
  const now = 1_000_000;
  assert.deepEqual({ ...fleetActivity(now, { usageTs: now - 600_000, usageTokens: 7, lastSpanTool: 'Edit', deepcode: { updatedAt: now, totalTokens: 1, lastTool: 'x' } }) },
    { lastActiveSecAgo: 600, lastTool: 'Edit', tokens: 7 });
  assert.deepEqual({ ...fleetActivity(now, {}) }, { lastActiveSecAgo: null, lastTool: null, tokens: null });
  assert.equal(deepcodeActivity('/Users/x/none', os.tmpdir(), SID), null);
});

test('the last tool is read from the tail of a large session file; a cut first line and junk rows are skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tail-'));
  try {
    const file = path.join(dir, 'x.jsonl');
    const big = JSON.stringify({ role: 'assistant', content: 'x'.repeat(300 * 1024) });
    fs.writeFileSync(file, [JSON.stringify({ role: 'tool', meta: { function: { name: 'old' } } }), big, JSON.stringify({ role: 'tool', meta: { function: { name: 'grep' } } }), '{not json', ''].join('\n'));
    assert.equal(lastToolInJsonl(file), 'grep');
    assert.equal(lastToolInJsonl(path.join(dir, 'missing.jsonl')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
