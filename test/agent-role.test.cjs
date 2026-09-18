'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  isDurableRole,
  preferredAgentRole,
  roleForHiveSpawn,
  isPmRole
} = loadTs('src/shared/agentRole.ts');

test('status captions are not durable roles', () => {
  for (const text of ['on standby', 'standby', 'idle', 'awaiting', 'a fresh harness', 'reconnecting…', '']) {
    assert.equal(isDurableRole(text), false, text);
  }
  assert.equal(isDurableRole('Head of Marketing — owns marketing-control-room'), true);
});

test('preferredAgentRole keeps a hire role over standby', () => {
  const hire = 'Head of Marketing — owns marketing-control-room and coordinates structured marketing work across the portfolio.';
  assert.equal(preferredAgentRole('on standby', hire), hire);
  assert.equal(preferredAgentRole(hire, 'on standby'), hire);
  assert.equal(preferredAgentRole('on standby', 'idle', true), 'on standby');
  assert.equal(preferredAgentRole(undefined, undefined, true), 'orchestrator (god)');
});

test('isPmRole matches the real hive PM job string', () => {
  // Pinned to the exact role/capabilities strings registry.json carries for the
  // three current Pam agents (pam-mtctnhm3, pam-mtidf2bl, pam-mtlbwbux) —
  // verified live against the hive registry on 2026-09-17.
  assert.equal(isPmRole({
    role: 'Project manager: routes tasks, tracks Jira, gates QA sign-off, reports to the Boss',
    capabilities: ['project-management', 'jira', 'coordination']
  }), true);
});

test('isPmRole matches a bare "PM" mention but not a substring collision', () => {
  assert.equal(isPmRole({ role: 'PM for the RistoSubito project' }), true);
  assert.equal(isPmRole({ capabilities: ['project manager'] }), true);
  assert.equal(isPmRole({ role: 'npm package maintainer' }), false);
  assert.equal(isPmRole({ role: 'prompt engineer' }), false);
});

test('isPmRole excludes god even if its role text would otherwise match', () => {
  assert.equal(isPmRole({ role: 'Project manager for everything', isGod: true }), false);
});

test('isPmRole is false for every other hive role (spot-checked against the live registry)', () => {
  for (const role of [
    'orchestrator (god)',
    'Adobe Commerce backend developer — Magento architecture, security-conscious, sharp debugger',
    'QA manager — verifies code against spec, drives code review, precise and unforgiving',
    'Adobe Commerce architect — deep Magento knowledge, turns requests into specs',
    'worker'
  ]) {
    assert.equal(isPmRole({ role }), false, role);
  }
});

test('isPmRole handles missing/undefined meta', () => {
  assert.equal(isPmRole(undefined), false);
  assert.equal(isPmRole({}), false);
});

test('roleForHiveSpawn omits a transient roster caption', () => {
  assert.equal(roleForHiveSpawn({ description: 'on standby' }), undefined);
  assert.equal(
    roleForHiveSpawn({ description: 'SRT product steward — owns marketing execution' }),
    'SRT product steward — owns marketing execution'
  );
  assert.equal(
    roleForHiveSpawn({ description: 'on standby', isGod: true }),
    'orchestrator (god)'
  );
});
