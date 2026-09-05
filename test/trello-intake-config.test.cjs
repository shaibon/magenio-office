'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trello-config-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { TRELLO_INTAKE_MISSION, readConfig } = loadTs('src/main/config.ts');
const { jiraLabelForCard } = loadTs('src/shared/trelloIntake.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('the intake mission targets god, ships disabled, and polls every 15 minutes', () => {
  assert.equal(TRELLO_INTAKE_MISSION.id, 'trello-intake');
  assert.equal(TRELLO_INTAKE_MISSION.to, 'god');
  assert.equal(TRELLO_INTAKE_MISSION.enabled, false);
  assert.equal(TRELLO_INTAKE_MISSION.intervalMs, 900000);
});

test('the mission body carries the rules that keep it from doing damage', () => {
  const body = TRELLO_INTAKE_MISSION.body;
  assert.match(body, /\/jira-bindings/, 'must read bindings from the broker');
  assert.match(body, /trello-<shortLink>/, 'must state the dedup label convention');
  assert.match(body, /abort[\s\S]{0,60}create nothing/i, 'must state the abort-on-failed-JQL rule');
  assert.match(body, /at most 10 new issues/i, 'must state the per-cycle cap');
  assert.match(body, /never write to trello/i, 'must state the read-only rule');
  assert.match(body, /unassigned/i, 'must state that the issue is created unassigned');
});

test('the dedup label in the mission body IS jiraLabelForCard', () => {
  // THE exactly-once seam. Spec §A wants one shared function cited by both the
  // mission body and the tests, "non una stringa riscritta a mano in due
  // posti" — but the body spells the label out and the assertion above matches
  // its own literal, so changing jiraLabelForCard to `trellocard-` would keep
  // every test green while god silently re-created the whole backlog on the
  // next cycle. These assertions build the expected text FROM the function, so
  // the two cannot drift: touch the function without touching the prompt (or
  // the reverse) and this fails.
  const body = TRELLO_INTAKE_MISSION.body;

  // Step 2 — how the label is formed from the card's shortLink.
  assert.ok(
    body.includes(jiraLabelForCard('<shortLink>')),
    `the mission body must form the label as ${jiraLabelForCard('<shortLink>')}`
  );
  // Step 3 — the same prefix quoted inside the deduplication JQL.
  assert.ok(
    body.includes(`"${jiraLabelForCard('…')}"`),
    `the dedup JQL must list labels of the form "${jiraLabelForCard('…')}"`
  );
});

test('a fresh config loads with no trello intake seeded flag set', () => {
  const cfg = readConfig();
  assert.equal(cfg.trelloIntakeSeeded, undefined);
});
