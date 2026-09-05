'use strict';

// POST /agents/<id>/(thaw|freeze) — the route that makes "god or Pam can call a
// frozen teammate back" true without a human clicking in the UI. The host wires
// `setAgentFrozen` to do BOTH writes (in-memory gate + persisted list); these
// tests pin the transport contract around it.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

/** A broker whose agent-control dep just records what it was asked to do. */
function makeBroker() {
  const calls = [];
  const broker = new IntegrationBroker({
    getRecord: () => undefined,
    getSecret: () => undefined,
    setAgentFrozen: (agentId, frozen) => { calls.push({ agentId, frozen }); }
  });
  return { broker, calls };
}

test('POST /agents/<id>/thaw unfreezes that agent', async () => {
  const { broker, calls } = makeBroker();
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/agents/andy-mtiqqouu/thaw`, {
    method: 'POST', headers: { 'x-md-broker-token': token }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { agentId: 'andy-mtiqqouu', frozen: false });
  assert.deepEqual(calls, [{ agentId: 'andy-mtiqqouu', frozen: false }]);
  broker.stop();
});

test('POST /agents/<id>/freeze freezes that agent', async () => {
  const { broker, calls } = makeBroker();
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/agents/dwight-mtcttd07/freeze`, {
    method: 'POST', headers: { 'x-md-broker-token': token }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { agentId: 'dwight-mtcttd07', frozen: true });
  assert.deepEqual(calls, [{ agentId: 'dwight-mtcttd07', frozen: true }]);
  broker.stop();
});

test('agent control requires a valid capability token', async () => {
  const { broker, calls } = makeBroker();
  await broker.start();
  const res = await fetch(`${broker.url()}/agents/andy-mtiqqouu/thaw`, { method: 'POST' });
  assert.equal(res.status, 401);
  // The point of the assertion: an unauthenticated call must not reach the dep.
  assert.deepEqual(calls, []);
  broker.stop();
});

test('any valid token may thaw, regardless of its integration scope', async () => {
  // Mirrors /jira-bindings: this is app state, not a credentialed proxy, so a
  // token granted zero integrations still works. Pinned so a future tightening
  // of allowedIds does not silently lock the orchestrator out again.
  const { broker, calls } = makeBroker();
  await broker.start();
  const token = broker.grant('worker-1', []);
  const res = await fetch(`${broker.url()}/agents/pam-mtctnhm3/thaw`, {
    method: 'POST', headers: { 'x-md-broker-token': token }
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  broker.stop();
});

test('GET on the agent-control route is rejected', async () => {
  // It mutates state; a GET must not do that even with a good token.
  const { broker, calls } = makeBroker();
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/agents/andy-mtiqqouu/thaw`, {
    headers: { 'x-md-broker-token': token }
  });
  assert.equal(res.status, 405);
  assert.deepEqual(calls, []);
  broker.stop();
});

test('a host that did not wire agent control answers 501, not a silent 200', async () => {
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/agents/andy-mtiqqouu/thaw`, {
    method: 'POST', headers: { 'x-md-broker-token': token }
  });
  assert.equal(res.status, 501);
  broker.stop();
});

test('an agent id containing a slash is percent-decoded, not truncated', async () => {
  const { broker, calls } = makeBroker();
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/agents/${encodeURIComponent('worker/odd-id')}/thaw`, {
    method: 'POST', headers: { 'x-md-broker-token': token }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ agentId: 'worker/odd-id', frozen: false }]);
  broker.stop();
});
