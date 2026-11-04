'use strict';

// PM Jira write scope, PM Slack alert scope, the broker-token plan on restore/wake,
// and the automation cap for god. No secrets: the upstream is a local fake with
// authType 'none'.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { brokerGrantPlan } = loadTs('src/shared/brokerGrant.ts');
const A = loadTs('src/shared/agentAutomations.ts');

async function setup(projects = ['BRAVI']) {
  const seen = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${up.address().port}/rest/api/3`;
  const broker = new IntegrationBroker({
    getRecord: (id) => (id === 'jira' ? { id: 'jira', label: 'J', kind: 'custom-rest', baseUrl: base, authType: 'none', enabled: true } : undefined),
    getSecret: () => undefined,
    pmJiraProjects: (agent) => (agent === 'pam-bravi' ? projects : [])
  });
  await broker.start();
  const pm = broker.grant('pty-1', ['jira'], { readOnly: true, agentId: 'pam-bravi', pmJira: true });
  const plain = broker.grant('pty-2', ['jira'], { readOnly: true, agentId: 'pam-x' }); // no pmJira
  const call = (tok, method, path, body, headers = {}) => fetch(`${broker.url()}/i/jira/${path}`, {
    method, headers: { 'x-md-broker-token': tok, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const done = () => { broker.stop(); up.close(); };
  return { broker, pm, plain, call, seen, done };
}

test('PM writes Jira on its own project: create, edit, assignee, transition, comment, worklog', async () => {
  const { pm, call, seen, done } = await setup();
  const ok = [
    ['POST', 'issue', { fields: { project: { key: 'BRAVI' }, summary: 's' } }],
    ['PUT', 'issue/BRAVI-12', { fields: { summary: 'x' } }],
    ['PUT', 'issue/bravi-12/assignee', { accountId: 'a' }],
    ['POST', 'issue/BRAVI-12/transitions', { transition: { id: '31' } }],
    ['POST', 'issue/BRAVI-12/comment', { body: 'hi' }],
    ['POST', 'issue/BRAVI-12/worklog?notifyUsers=false', { timeSpent: '1h' }],
    ['POST', 'rest/api/3/issue/BRAVI-12/comment', { body: 'hi' }]
  ];
  for (const [m, p, b] of ok) assert.equal((await call(pm, m, p, b)).status, 200, `${m} ${p}`);
  assert.equal(seen.length, ok.length);
  assert.equal(seen[1].body, JSON.stringify({ fields: { summary: 'x' } }), 'body is forwarded intact');
  done();
});

test('PM cannot write other projects, other verbs, or smuggle keys', async () => {
  const { pm, plain, call, seen, done } = await setup();
  const deny = [
    [pm, 'PUT', 'issue/OTHER-1', {}],
    [pm, 'POST', 'issue/OTHER-1/comment', {}],
    [pm, 'POST', 'issue', { fields: { project: { key: 'OTHER' } } }],
    [pm, 'POST', 'issue', { fields: { project: { key: 'BRAVI', id: '10000' } } }],
    [pm, 'POST', 'issue', { fields: {} }],
    [pm, 'POST', 'issue', { fields: { project: { key: 'BRAVI' } }, update: { issuelinks: [{ add: { inwardIssue: { key: 'OTHER-1' } } }] } }],
    [pm, 'PUT', 'issue/BRAVI-1', { update: { issuelinks: [] } }],
    [pm, 'DELETE', 'issue/BRAVI-1'],
    [pm, 'PATCH', 'issue/BRAVI-1', {}],
    [pm, 'PUT', 'issue/10023', {}],
    [pm, 'PUT', 'issue/BRAVI-1%2f..%2fOTHER-1', {}],
    [pm, 'PUT', 'issue/BRAVI-1/../OTHER-1', {}],
    [pm, 'POST', 'issue/BRAVI-1/transitions/../../OTHER-1', {}],
    [pm, 'POST', 'issue/bulk', {}],
    [pm, 'POST', 'search', {}],
    [pm, 'POST', 'project', {}],
    [plain, 'POST', 'issue/BRAVI-1/comment', {}]
  ];
  for (const [t, m, p, b] of deny) assert.equal((await call(t, m, p, b)).status, 403, `${m} ${p}`);
  assert.equal(seen.length, 0, 'nothing reached Jira');
  done();
});

test('method override headers never turn a PM request into a write; GET still reads', async () => {
  const { pm, call, seen, done } = await setup();
  for (const h of ['x-http-method-override', 'x-http-method', 'x-method-override']) {
    assert.equal((await call(pm, 'GET', 'issue/BRAVI-1', undefined, { [h]: 'DELETE' })).status, 403);
    assert.equal((await call(pm, 'POST', 'issue/BRAVI-1/comment', {}, { [h]: 'PUT' })).status, 403);
  }
  assert.equal((await call(pm, 'GET', 'search?jql=project%3DOTHER')).status, 200);
  assert.equal(seen.length, 1);
  done();
});

test('binding changes apply live; no binding means no write', async () => {
  const { pm, call, done } = await setup([]);
  assert.equal((await call(pm, 'POST', 'issue/BRAVI-1/comment', {})).status, 403);
  done();
});

test('other broker writes stay forbidden for a PM (automations, agents, freeze)', async () => {
  const { broker, pm, done } = await setup();
  const h = { 'x-md-broker-token': pm };
  assert.equal((await fetch(`${broker.url()}/automations`, { method: 'POST', headers: h, body: '{}' })).status, 403);
  assert.equal((await fetch(`${broker.url()}/agents/a/freeze`, { method: 'POST', headers: h })).status, 403);
  done();
});

test('pmMayAlert: only a PM token, only its own project', async () => {
  const { broker, pm, plain, done } = await setup();
  assert.equal(broker.pmMayAlert(pm, 'bravi'), true);
  assert.equal(broker.pmMayAlert(pm, 'OTHER'), false);
  assert.equal(broker.pmMayAlert(pm, undefined), false);
  assert.equal(broker.pmMayAlert(plain, 'BRAVI'), false);
  assert.equal(broker.pmMayAlert('nope', 'BRAVI'), false);
  done();
});

test('brokerGrantPlan: PM is found by HIVE id even when the pty id differs (restore / wake)', () => {
  const pms = new Set(['pam-mtidf2bl']);
  const isPm = (id) => pms.has(id);
  const restored = brokerGrantPlan({ id: 'pam-mtidf2bl' }, 'pty-new-7', isPm);
  assert.deepEqual(restored, { agentId: 'pam-mtidf2bl', readOnly: true, pmJira: true });
  assert.equal(brokerGrantPlan({ id: 'andy-1' }, 'pam-mtidf2bl', isPm), null, 'the pty id is not an identity');
  assert.deepEqual(brokerGrantPlan({ id: 'god', isGod: true }, 'pty-9', isPm), { agentId: 'god', readOnly: false, pmJira: false });
  assert.equal(brokerGrantPlan(undefined, 'x', isPm), null);
});

test('automation cap: per creator for agents, per recipient for god', () => {
  const store = [];
  const host = {
    list: () => store, save: (n) => { store.splice(0, store.length, ...n); },
    targetExists: () => true, isGod: (id) => id === 'god', log: () => {}
  };
  const mk = (to) => ({ label: 'l', body: 'b', to, intervalMinutes: 60 });
  for (let i = 0; i < 10; i++) assert.equal(A.createAutomation(host, 'god', mk('pam-a')).status, 201);
  assert.equal(A.createAutomation(host, 'god', mk('pam-a')).status, 429, '11th for the same Pam');
  assert.equal(A.createAutomation(host, 'god', mk('pam-b')).status, 201, 'another Pam has its own 10');
  for (let i = 0; i < 10; i++) assert.equal(A.createAutomation(host, 'andy', mk('pam-a')).status, 201);
  assert.equal(A.createAutomation(host, 'andy', mk('pam-b')).status, 429, 'agents: 10 per creator');
});
