'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const comp = (n) => read(`src/renderer/src/components/${n}.tsx`);

test('every surface that shows an agent status goes through the shared hibernated source (t-284)', () => {
  for (const n of ['AgentDetailPanel', 'CommandCenterPanel', 'MemoryGraphPanel', 'FullscreenTerminal']) {
    const src = comp(n);
    assert.match(src, /from '@\/hooks\/useHibernatedIds'/, `${n} imports the shared source`);
    assert.doesNotMatch(src, /<PixelBadge\s+status=\{(?:agent|a|node)\.status\}/, `${n} must not badge the raw status`);
  }
  assert.match(comp('FullscreenTerminal'), /hibernated \? 'hibernated'/);
});

test('hibernated wins over any status once the process is gone; one shared store, not per-component state', () => {
  assert.match(read('src/renderer/src/hooks/useHibernatedIds.ts'), /useSyncExternalStore/);
});

test('the freeze button is gone from the control strip and its i18n keys are dropped', () => {
  const strip = comp('AgentControlStrip');
  assert.doesNotMatch(strip, /toggleFreeze|controlAutoDelivery|agentControl\.freeze|flashFrozen|flashUnfrozen/);
  for (const l of ['en', 'zh-CN', 'ar']) {
    const keys = JSON.parse(read(`src/renderer/src/i18n/locales/${l}.json`)).agentControl;
    for (const k of ['freeze', 'freezeTip', 'freezeAria', 'flashFrozen', 'flashUnfrozen']) {
      assert.equal(k in keys, false, `${l}.agentControl.${k} removed`);
    }
  }
});

test('boot clears a freeze left in an old config before anything reads it', () => {
  const src = read('src/main/index.ts');
  const clear = src.indexOf('writeConfig({ autoDeliveryPausedAgents: [] })');
  const load = src.indexOf('control.replaceAutoDeliveryPauses(readConfig()');
  assert.ok(clear > 0 && load > clear, 'cleared before the control state is seeded');
});

const loadTs = require('./load-ts.cjs');
const { createHibernatedStore, displayStatus } = loadTs('src/renderer/src/hooks/hibernatedStore.ts');

test('displayStatus: hibernated wins for every status, others pass through', () => {
  for (const s of ['idle', 'working', 'success', 'waiting', 'blocked']) {
    assert.equal(displayStatus(s, true), 'hibernated');
    assert.equal(displayStatus(s, false), s);
  }
});

function harness(state) {
  let cb; const calls = [];
  const pending = [];
  const bridge = {
    hibernateState: (id) => { calls.push(id); return new Promise((res) => pending.push(() => res({ hibernated: state[id] }))); },
    onHiveAgentHibernation: (f) => { cb = f; return () => { cb = undefined; }; }
  };
  return { store: createHibernatedStore(() => bridge), emit: (e) => cb && cb(e), calls, pending, listening: () => !!cb };
}
const tick = () => new Promise((r) => setImmediate(r));

test('remount re-reads state: a wake heard by nobody does not leave the store asleep', async () => {
  const state = { pam: true };
  const h = harness(state);
  let off = h.store.subscribe(() => {});
  h.store.seed(['pam']); h.pending.shift()(); await tick();
  assert.equal(h.store.snapshot().has('pam'), true);
  off();
  assert.equal(h.listening(), false);
  state.pam = false; // main woke it while no view was mounted
  off = h.store.subscribe(() => {});
  h.store.seed(['pam']); assert.equal(h.calls.length, 2, 'seeded again after remount');
  h.pending.shift()(); await tick();
  assert.equal(h.store.snapshot().has('pam'), false);
});

test('a seed reply older than a newer event is discarded', async () => {
  const h = harness({ pam: true });
  h.store.subscribe(() => {});
  h.store.seed(['pam']);
  h.emit({ id: 'pam', hibernated: false }); // wake arrives before the seed reply
  h.pending.shift()(); await tick();
  assert.equal(h.store.snapshot().has('pam'), false);
  h.emit({ id: 'pam', hibernated: true });
  assert.equal(h.store.snapshot().has('pam'), true);
});

test('the memory-graph status ring uses the displayed status too', () => {
  assert.doesNotMatch(comp('MemoryGraphPanel'), /cth-status-\$\{n\.status\}/);
});
