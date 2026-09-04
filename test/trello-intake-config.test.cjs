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
  assert.match(body, /abort/i, 'must state the abort-on-failed-JQL rule');
  assert.match(body, /\b10\b/, 'must state the per-cycle cap');
  assert.match(body, /never write to trello/i, 'must state the read-only rule');
  assert.match(body, /unassigned/i, 'must state that the issue is created unassigned');
});

test('a fresh config loads with no trello intake seeded flag set', () => {
  const cfg = readConfig();
  assert.equal(cfg.trelloIntakeSeeded, undefined);
});
