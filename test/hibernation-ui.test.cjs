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

test('hibernated replaces idle only; one shared store, not per-component state', () => {
  const src = read('src/renderer/src/hooks/useHibernatedIds.ts');
  assert.match(src, /isHibernated && status === 'idle' \? 'hibernated' : status/);
  assert.match(src, /useSyncExternalStore/);
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
