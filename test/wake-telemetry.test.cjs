'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { lastActiveSecAgo } = loadTs('src/shared/fleetActivity.ts');
const { createHibernatedStore } = loadTs('src/renderer/src/hooks/hibernatedStore.ts');

const tick = () => new Promise((r) => setImmediate(r));

test('a telemetry-less agent (DeepCode first turn) shows activity from its terminal output, not null', () => {
  const now = 1_000_000;
  assert.equal(lastActiveSecAgo(now, undefined, now - 12_000), 12, 'working: output 12s ago');
  assert.equal(lastActiveSecAgo(now, undefined, undefined), null, 'no pty, no telemetry');
});

test('telemetry wins; a terminal redraw never makes a telemetry agent look active', () => {
  const now = 1_000_000;
  assert.equal(lastActiveSecAgo(now, now - 600_000, now - 1_000), 600);
});

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

test('wiring: hibernation events reach every window; both fleet snapshots use the activity helper', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(main, /for \(const w of allWindows\) \{ if \(!w\.isDestroyed\(\) && !w\.webContents\.isDestroyed\(\)\) w\.webContents\.send\('hive:agentHibernation'/);
  assert.equal((main.match(/lastActiveSecAgo\(now, u\?\.ts, ptyOutputAtFor\(id\)\)/g) || []).length, 2);
});
