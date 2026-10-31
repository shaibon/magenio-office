'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { hibernatedDrainAction, checkPrecondition } = loadTs('src/renderer/src/hooks/queueDelivery.ts');

const hive = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'), 'utf8');

test('an hourly context tick wakes 0 hibernated agents: scheduled commands are dropped, mail and user messages wake', () => {
  // 55 sleepers each hold a scheduled /compact (precondition awake): none is a wake.
  const woken = Array.from({ length: 55 }, () => ({ precondition: 'awake' })).filter((m) => hibernatedDrainAction(m) === 'wake');
  assert.equal(woken.length, 0);
  assert.equal(hibernatedDrainAction({}), 'wake', 'a user message / work order still wakes');
  assert.equal(hibernatedDrainAction({ precondition: 'inbox-nonempty' }), 'wake', 'the inbox nudge (real mail) still wakes');
});

test('an awake-only message is still delivered to a live agent', async () => {
  assert.equal(await checkPrecondition({ precondition: 'awake' }, async () => []), 'send');
});

test('wiring: the tick skips sleepers, queues commands as awake-only, and the drain drops them instead of waking', () => {
  assert.match(hive, /const fire = async \(action: 'compact' \| 'clear', rule: ContextRule\): Promise<void> => \{[\s\S]{0,700}isAgentHibernated\?\.\(x\.id\)/);
  assert.match(hive, /if \(asleep\.has\(a\.id\)\) continue;/);
  assert.match(hive, /compactUsed: used, precondition: 'awake' \} : \{ precondition: 'awake' \}/);
  assert.match(hive, /hibernatedDrainAction\(next\) === 'drop'\) \{ removeQueuedMessage\(srcId, next\.id\); return \{ sent: false \}; \}\s*\n\s*void window\.cth\.wakeAgent\?\.\(target\.id, 'queued-message'\)/);
});
