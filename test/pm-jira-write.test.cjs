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
const { alertChannelFor } = loadTs('src/shared/jiraProjects.ts');

async function setup(projects = ['BRAVI'], moved = {}) {
  const seen = [];
  const lookups = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      // The broker's own project check (GET issue/<key>?fields=project): answer with where the key lives NOW.
      const lk = /^\/rest\/api\/3\/issue\/([A-Za-z0-9_-]+)\?fields=project$/.exec(req.url);
      if (req.method === 'GET' && lk) {
        lookups.push(lk[1]);
        const key = lk[1].toUpperCase();
        const project = moved[key] ?? key.slice(0, key.lastIndexOf('-'));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ fields: { project: { key: project } } })); return;
      }
      seen.push({ method: req.method, url: req.url, body: b, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
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
  // Raw body + arbitrary headers (for encodings the JSON helper cannot produce).
  const raw = (tok, method, path, buf, headers = {}) => fetch(`${broker.url()}/i/jira/${path}`, {
    method, headers: { 'x-md-broker-token': tok, ...headers }, body: buf
  });
  const done = () => { broker.stop(); up.close(); up.closeAllConnections?.(); };
  return { broker, pm, plain, call, raw, seen, lookups, done };
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

// ── review FIX-FIRST (t-335) ─────────────────────────────────────────────────

const LINK = { update: { issuelinks: [{ add: { type: { name: 'Relates' }, inwardIssue: { key: 'OTHER-1' } } }] } };

test('H1: the JSON \\u-escaped key, UTF-16 and content-encoding bypasses are refused; nothing reaches Jira', async () => {
  const { pm, raw, seen, done } = await setup();
  const json = { 'content-type': 'application/json' };
  // {"update":{"issue\u006cinks":[...]}} — the old regex on the raw bytes missed this
  const escaped = '{"update":{"issue\\u006cinks":[{"add":{"inwardIssue":{"key":"OTHER-1"}}}]}}';
  for (const [m, p] of [['PUT', 'issue/BRAVI-1'], ['POST', 'issue/BRAVI-1/transitions'], ['POST', 'issue/BRAVI-1/comment'], ['POST', 'issue']]) {
    assert.equal((await raw(pm, m, p, escaped, json)).status, 403, `escaped ${m} ${p}`);
  }
  const utf16 = Buffer.from(JSON.stringify({ fields: { summary: 'x' } }), 'utf16le');
  assert.equal((await raw(pm, 'PUT', 'issue/BRAVI-1', utf16, { 'content-type': 'application/json; charset=utf-16le' })).status, 403, 'utf-16 charset');
  assert.notEqual((await raw(pm, 'PUT', 'issue/BRAVI-1', utf16, json)).status, 200, 'utf-16 bytes without a charset are not valid utf-8 JSON');
  assert.equal((await raw(pm, 'PUT', 'issue/BRAVI-1', Buffer.from('{}'), { ...json, 'content-encoding': 'gzip' })).status, 403, 'content-encoding');
  assert.equal((await raw(pm, 'PUT', 'issue/BRAVI-1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"fields":{}}')]), json)).status >= 400, true, 'BOM is not accepted silently');
  assert.equal(seen.length, 0, 'nothing reached Jira');
  done();
});

test('H1: allow-list — links, parent, epic and unknown fields are refused at any depth, on every verb', async () => {
  const { pm, call, seen, done } = await setup();
  const deny = [
    ['PUT', 'issue/BRAVI-1', LINK],
    ['PUT', 'issue/BRAVI-1', { fields: { parent: { key: 'OTHER-1' } } }],
    ['PUT', 'issue/BRAVI-1', { fields: { customfield_10014: 'OTHER-1' } }],
    ['PUT', 'issue/BRAVI-1', { fields: { summary: 's', description: { type: 'doc', content: [{ type: 'x', attrs: { inwardIssue: 1 } }] } } }],
    ['PUT', 'issue/BRAVI-1', { fields: { ISSUELINKS: [] } }],
    ['PUT', 'issue/BRAVI-1', { properties: [] }],
    ['PUT', 'issue/BRAVI-1', { update: { summary: [{ set: 'x' }] } }],
    ['PUT', 'issue/BRAVI-1', [1]],
    ['PUT', 'issue/BRAVI-1', 'x'],
    ['POST', 'issue', { fields: { project: { key: 'BRAVI' }, parent: { key: 'OTHER-1' } } }],
    ['POST', 'issue/BRAVI-1/transitions', { transition: { id: '1' }, ...LINK }],
    ['POST', 'issue/BRAVI-1/transitions', { transition: { id: '1', to: { id: '2' } } }],
    ['POST', 'issue/BRAVI-1/comment', { body: 'x', properties: [{ key: 'k', value: 1 }] }],
    ['POST', 'issue/BRAVI-1/comment', { body: { type: 'doc', content: [{ outwardIssue: {} }] } }],
    ['POST', 'issue/BRAVI-1/worklog', { timeSpent: '1h', issuelinks: [] }],
    ['PUT', 'issue/BRAVI-1/assignee', { accountId: 'a', extra: 1 }]
  ];
  for (const [m, p, b] of deny) assert.equal((await call(pm, m, p, b)).status, m === 'PUT' && b === 'x' ? 403 : 403, `${m} ${p} ${JSON.stringify(b).slice(0, 60)}`);
  assert.equal(seen.length, 0);
  done();
});

test('H1: what is forwarded is the RE-SERIALISED parsed document (duplicate keys cannot differ between check and Jira)', async () => {
  const { pm, raw, seen, done } = await setup();
  // duplicate "summary": JSON.parse keeps the last; Jira must receive exactly that single value
  const r = await raw(pm, 'PUT', 'issue/BRAVI-1', '{"fields":{"summary":"a","summary":"b"}}', { 'content-type': 'application/json; charset=UTF-8' });
  assert.equal(r.status, 200);
  assert.equal(seen[0].body, '{"fields":{"summary":"b"}}');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  done();
});

test('M1: an issue MOVED to another project is refused even though its old key has our prefix', async () => {
  const { pm, call, seen, lookups, done } = await setup(['BRAVI'], { 'BRAVI-12': 'OTHER', 'BRAVI-13': 'BRAVI' });
  assert.equal((await call(pm, 'PUT', 'issue/BRAVI-12', { fields: { summary: 'x' } })).status, 403, 'BRAVI-12 now lives in OTHER');
  assert.equal((await call(pm, 'POST', 'issue/BRAVI-12/comment', { body: 'x' })).status, 403);
  assert.equal(seen.length, 0);
  assert.equal((await call(pm, 'PUT', 'issue/BRAVI-13', { fields: { summary: 'x' } })).status, 200);
  assert.equal((await call(pm, 'POST', 'issue/BRAVI-13/comment', { body: 'x' })).status, 200);
  done();
});

test('H1: the project is re-verified on EVERY write: an issue moved between two writes is refused (no cache)', async () => {
  const moved = {};
  const { pm, call, seen, lookups, done } = await setup(['BRAVI'], moved);
  assert.equal((await call(pm, 'POST', 'issue/BRAVI-20/comment', { body: 'a' })).status, 200);
  moved['BRAVI-20'] = 'OTHER'; // moved to another project while the old key still resolves
  assert.equal((await call(pm, 'POST', 'issue/BRAVI-20/comment', { body: 'b' })).status, 403);
  assert.equal(lookups.filter((k) => k === 'BRAVI-20').length, 2, 'one lookup per write');
  assert.equal(seen.length, 1, 'only the first comment reached Jira');
  done();
});

test('M1: when the project cannot be verified the write fails closed', async () => {
  const seen = [];
  const up = http.createServer((req, res) => { seen.push(req.url); res.writeHead(500); res.end('{}'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const broker = new IntegrationBroker({
    getRecord: () => ({ id: 'jira', label: 'J', kind: 'custom-rest', baseUrl: `http://127.0.0.1:${up.address().port}/rest/api/3`, authType: 'none', enabled: true }),
    getSecret: () => undefined, pmJiraProjects: () => ['BRAVI']
  });
  await broker.start();
  const pm = broker.grant('p', ['jira'], { readOnly: true, agentId: 'pam-bravi', pmJira: true });
  const r = await fetch(`${broker.url()}/i/jira/issue/BRAVI-1`, { method: 'PUT', headers: { 'x-md-broker-token': pm, 'content-type': 'application/json' }, body: '{"fields":{"summary":"x"}}' });
  assert.equal(r.status, 502);
  assert.deepEqual(seen.filter((u) => !/fields=project/.test(u)), [], 'no write was attempted');
  broker.stop(); up.close(); up.closeAllConnections?.();
});

test('M2: only allow-listed query parameters pass (no _method, no unknown, no repeats)', async () => {
  const { pm, call, seen, done } = await setup();
  for (const q of ['?_method=DELETE', '?expand=names&foo=1', '?notifyUsers=false&notifyUsers=true', '?notifyUsers=maybe', '?overrideScreenSecurity=true', '?=x', '?&']) {
    assert.equal((await call(pm, 'PUT', `issue/BRAVI-1${q}`, { fields: { summary: 'x' } })).status, 403, q);
  }
  assert.equal(seen.length, 0);
  assert.equal((await call(pm, 'PUT', 'issue/BRAVI-1?notifyUsers=false&returnIssue=true', { fields: { summary: 'x' } })).status, 200);
  done();
});

test('L1: a PM never falls back to the global alert channel; god still does', () => {
  const bindings = [
    { key: 'BRAVI', enabled: true, slackAlertChannel: 'C0AAAAAAAA' },
    { key: 'NOCHAN', enabled: true }
  ];
  const fb = 'C0FALLBACK';
  assert.equal(alertChannelFor(bindings, 'BRAVI', fb, true), 'C0AAAAAAAA');
  assert.equal(alertChannelFor(bindings, 'NOCHAN', fb, true), null, 'PM: project without its own channel gets nothing');
  assert.equal(alertChannelFor(bindings, 'NOCHAN', fb, false), fb, 'god keeps the fallback');
  assert.equal(alertChannelFor(bindings, undefined, fb, true), null);
  assert.equal(alertChannelFor(bindings, undefined, fb), fb);
  const slack = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/main/slack.ts'), 'utf8');
  assert.match(slack, /noFallback: pmCandidate/);
  const idx = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(idx, /!!opts\?\.noFallback/);
});

test('L2: god alias and real id are one recipient; god has a global ceiling', () => {
  const store = [];
  const host = {
    list: () => store, save: (n) => { store.splice(0, store.length, ...n); },
    targetExists: () => true, isGod: (id) => id === 'god-1', godId: () => 'god-1', log: () => {}
  };
  const mk = (to) => ({ label: 'l', body: 'b', to, intervalMinutes: 60 });
  for (let i = 0; i < 5; i++) assert.equal(A.createAutomation(host, 'god-1', mk('god')).status, 201);
  for (let i = 0; i < 5; i++) assert.equal(A.createAutomation(host, 'god-1', mk('god-1')).status, 201);
  assert.equal(A.createAutomation(host, 'god-1', mk('god')).status, 429, "'god' and the real id share one cap of 10");
  // global ceiling: 100 in total across recipients (10 each => 10 recipients)
  store.length = 0;
  for (let r = 0; r < 10; r++) for (let i = 0; i < 10; i++) assert.equal(A.createAutomation(host, 'god-1', mk(`agent-${r}`)).status, 201);
  const over = A.createAutomation(host, 'god-1', mk('agent-fresh'));
  assert.equal(over.status, 429);
  assert.match(over.body.error, /in total/);
  assert.equal(A.MAX_GOD_AUTOMATIONS_TOTAL, 100);
});

test('wiring: the token broker still revokes alert for a PM whose binding is gone (pmMayAlert is live)', async () => {
  let bound = ['BRAVI'];
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined, pmJiraProjects: () => bound });
  await broker.start();
  const pm = broker.grant('p', ['jira'], { readOnly: true, agentId: 'pam-bravi', pmJira: true });
  assert.equal(broker.pmMayAlert(pm, 'BRAVI'), true);
  bound = [];
  assert.equal(broker.pmMayAlert(pm, 'BRAVI'), false, 'binding revoked => alert revoked, same token');
  broker.stop();
});

test('coexistence with Team AI remote capabilities: a PM token and a remote token for the same agent stay in their lanes', async () => {
  const { broker, pm, call, seen, done } = await setup();
  const remote = broker.grantRemote('n8n', 'pam-bravi', 'BRAVI');
  assert.ok(remote);
  assert.notEqual(remote, pm);
  // the PM token is still valid after the remote one was minted, and still writes its project
  assert.equal((await call(pm, 'POST', 'issue/BRAVI-1/comment', { body: 'x' })).status, 200);
  // the PM token cannot use the remote route; the remote token cannot reach Jira
  assert.equal((await fetch(`${broker.url()}/n8n-mcp`, { method: 'POST', headers: { 'x-md-broker-token': pm } })).status, 403);
  assert.equal((await call(remote, 'POST', 'issue/BRAVI-1/comment', { body: 'x' })).status, 403);
  assert.equal(seen.length, 1, 'only the PM comment reached Jira');
  // revoking the remote capability leaves the PM token alone
  broker.revokeRemote('n8n', 'pam-bravi');
  assert.equal((await call(pm, 'POST', 'issue/BRAVI-1/comment', { body: 'y' })).status, 200);
  done();
});
