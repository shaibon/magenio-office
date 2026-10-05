'use strict';

// /automations — validation, ownership and caps, plus the broker transport.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const A = loadTs('src/shared/agentAutomations.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

function makeHost(seed = []) {
  const state = { missions: seed, logs: [] };
  const host = {
    list: () => state.missions,
    save: (n) => { state.missions = n; },
    targetExists: (id) => ['god', 'dwight', 'andy'].includes(id),
    isGod: (id) => id === 'god',
    log: (e) => state.logs.push(e)
  };
  return { host, state };
}
const good = { label: 'Sweep', body: 'check the board', to: 'dwight', intervalMinutes: 30 };

test('create stores an owned dispatch trigger and logs the actor', () => {
  const { host, state } = makeHost();
  const r = A.createAutomation(host, 'andy', good);
  assert.equal(r.status, 201);
  assert.equal(state.missions[0].createdBy, 'andy');
  assert.equal(state.missions[0].intervalMs, 30 * 60_000);
  assert.equal(state.missions[0].kind, 'dispatch');
  assert.deepEqual(state.logs[0], { kind: 'automation-create', actor: 'andy', id: r.body.id, label: 'Sweep', to: 'dwight' });
});

test('validation: interval floor, schedule shape, unknown target, unknown field', () => {
  const { host } = makeHost();
  const bad = (o) => A.createAutomation(host, 'andy', { ...good, ...o }).status;
  assert.equal(bad({ intervalMinutes: 4 }), 400);
  assert.equal(bad({ intervalMinutes: 5.5 }), 400);
  assert.equal(bad({ intervalMinutes: 99999 }), 400);
  assert.equal(bad({ weekly: { days: [1], minute: 540 } }), 400); // both shapes
  assert.equal(bad({ to: 'nobody' }), 400);
  assert.equal(bad({ label: '' }), 400);
  assert.equal(bad({ kind: 'heartbeat' }), 400);
  assert.equal(A.createAutomation(host, 'andy', { label: 'x', body: 'y', to: 'god' }).status, 400); // no schedule
  assert.equal(A.createAutomation(host, 'andy', { label: 'x', body: 'y', to: 'god', weekly: { days: [7], minute: 5 } }).status, 400);
  assert.equal(A.createAutomation(host, 'andy', { label: 'x', body: 'y', to: 'god', weekly: { days: [1, 3], minute: 540 } }).status, 201);
});

test('per-agent cap', () => {
  const { host } = makeHost();
  for (let i = 0; i < A.MAX_AUTOMATIONS_PER_AGENT; i++) assert.equal(A.createAutomation(host, 'andy', good).status, 201);
  assert.equal(A.createAutomation(host, 'andy', good).status, 429);
  assert.equal(A.createAutomation(host, 'dwight', good).status, 201); // cap is per agent
});

test('ownership: others denied, owner and god allowed, system triggers locked', () => {
  const { host, state } = makeHost([{ id: 'hb', label: 'beat', intervalMs: 1, to: 'god', body: '', enabled: true, kind: 'heartbeat' }]);
  const id = A.createAutomation(host, 'andy', good).body.id;
  assert.equal(A.updateAutomation(host, 'dwight', id, { enabled: false }).status, 403);
  assert.equal(A.deleteAutomation(host, 'dwight', id).status, 403);
  assert.equal(A.updateAutomation(host, 'andy', id, { enabled: false }).status, 200);
  assert.equal(A.updateAutomation(host, 'god', id, { label: 'renamed' }).status, 200);
  assert.equal(A.updateAutomation(host, 'god', 'hb', { enabled: false }).status, 403);
  assert.equal(A.deleteAutomation(host, 'god', 'hb').status, 403);
  assert.equal(A.deleteAutomation(host, 'andy', id).status, 200);
  assert.equal(state.missions.length, 1);
  assert.equal(A.deleteAutomation(host, 'andy', id).status, 404);
});

test('update switches schedule shape without leaving both', () => {
  const { host, state } = makeHost();
  const id = A.createAutomation(host, 'andy', good).body.id;
  A.updateAutomation(host, 'andy', id, { weekly: { days: [5, 1], minute: 60 } });
  assert.deepEqual(state.missions[0].weekly, { days: [1, 5], minute: 60 });
  A.updateAutomation(host, 'andy', id, { intervalMinutes: 15 });
  assert.equal(state.missions[0].weekly, undefined);
  assert.equal(state.missions[0].intervalMs, 15 * 60_000);
  assert.equal(A.updateAutomation(host, 'andy', id, { intervalMinutes: 1 }).status, 400);
});

test('broker: actor comes from the token, read-only token can only list', async () => {
  const { host, state } = makeHost();
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined, automations: host });
  await broker.start();
  const tok = broker.grant('andy', []);
  const ro = broker.grant('pam', [], { readOnly: true });
  const call = (token, method, path, body) => fetch(`${broker.url()}${path}`, {
    method, headers: { 'x-md-broker-token': token, 'content-type': 'application/json' }, body: body && JSON.stringify(body)
  });
  const created = await call(tok, 'POST', '/automations', good);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal(state.missions[0].createdBy, 'andy');
  assert.equal((await call(ro, 'GET', '/automations')).status, 200);
  assert.equal((await call(ro, 'POST', '/automations', good)).status, 403);
  assert.equal((await call(ro, 'DELETE', `/automations/${id}`)).status, 403);
  assert.equal((await call(tok, 'PATCH', `/automations/${id}`, { intervalMinutes: 2 })).status, 400);
  assert.equal((await call(tok, 'DELETE', `/automations/${id}`)).status, 200);
  const junk = await fetch(`${broker.url()}/automations`, { method: 'POST', headers: { 'x-md-broker-token': tok }, body: '{nope' });
  assert.equal(junk.status, 400);
  assert.equal((await fetch(`${broker.url()}/automations`)).status, 401);
  broker.stop();
});
