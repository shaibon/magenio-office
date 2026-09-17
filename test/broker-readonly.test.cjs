'use strict';

// t-056: a PM (Pam) gets a broker capability that is GET-only — grant(..., {
// readOnly: true }) — checked once, before any route dispatch, so it covers
// every route uniformly (the integration proxy, /jira-bindings, agent control),
// not just the one the PM is expected to use today.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

function makeBroker() {
  const calls = [];
  const broker = new IntegrationBroker({
    getRecord: () => undefined,
    getSecret: () => undefined,
    getJiraBindings: () => ({ bindings: [], poll: { pollIntervalMs: 300000, assigneeFilter: 'currentUser', statusFilter: 'To Do' } }),
    setAgentFrozen: (agentId, frozen) => { calls.push({ agentId, frozen }); }
  });
  return { broker, calls };
}

test('a read-only token may GET /jira-bindings', async () => {
  const { broker } = makeBroker();
  await broker.start();
  const token = broker.grant('pam-1', [], { readOnly: true });
  const res = await fetch(`${broker.url()}/jira-bindings`, { headers: { 'x-md-broker-token': token } });
  assert.equal(res.status, 200);
  broker.stop();
});

test('a read-only token cannot POST to the agent-control route', async () => {
  const { broker, calls } = makeBroker();
  await broker.start();
  const token = broker.grant('pam-1', [], { readOnly: true });
  const res = await fetch(`${broker.url()}/agents/andy-mtiqqouu/thaw`, {
    method: 'POST', headers: { 'x-md-broker-token': token }
  });
  assert.equal(res.status, 403);
  assert.deepEqual(calls, [], 'the dep must never be reached for a rejected write');
  broker.stop();
});

test('a read-only token cannot POST/PUT/DELETE through the integration proxy route', async () => {
  const { broker } = makeBroker();
  await broker.start();
  const token = broker.grant('pam-1', ['jira'], { readOnly: true });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await fetch(`${broker.url()}/i/jira/rest/api/3/issue`, { method, headers: { 'x-md-broker-token': token } });
    assert.equal(res.status, 403, method);
    const body = await res.json();
    assert.equal(body.code, 'forbidden');
    assert.match(body.error, /read-only/);
  }
  broker.stop();
});

test('a read-only token still reaches GET routing past the read-only gate (proxy/allowedIds logic, not blocked at 403-readonly)', async () => {
  const { broker } = makeBroker();
  await broker.start();
  const token = broker.grant('pam-1', ['jira'], { readOnly: true });
  const res = await fetch(`${broker.url()}/i/jira/rest/api/3/issue`, { headers: { 'x-md-broker-token': token } });
  // No getRecord wired here, so this 404s past the read-only gate (unknown
  // integration) — the point is it is NOT the read-only 403.
  assert.equal(res.status, 404);
  broker.stop();
});

test('a non-read-only token is unaffected (regression)', async () => {
  const { broker, calls } = makeBroker();
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/agents/andy-mtiqqouu/thaw`, {
    method: 'POST', headers: { 'x-md-broker-token': token }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ agentId: 'andy-mtiqqouu', frozen: false }]);
  broker.stop();
});
