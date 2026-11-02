'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  MCP_CATALOG, defaultMcpDefaults, mergeMcpConsent,
  remoteSecretRef, remoteBrokerEnv, remoteBrokerRoute,
  normalizeRemoteUrl, resolveRemoteProject
} = loadTs('src/shared/mcpCatalog.ts');

test('Team AI is a disabled secret remote with no default agents', () => {
  const entry = MCP_CATALOG.find((e) => e.id === 'teamai');
  assert.ok(entry);
  assert.equal(entry.label, 'Team AI (read-only)');
  assert.equal(entry.remote, true);
  assert.equal(entry.tier, 'secret');
  assert.equal(entry.defaultEnabled, false);
  assert.deepEqual(defaultMcpDefaults().teamai, { enabled: false });
  assert.equal(mergeMcpConsent('teamai', undefined, { enabled: true }).enabled, true);
});

test('remote ids have separate secret refs, broker env, routes and fail closed', () => {
  assert.equal(remoteSecretRef('teamai', 'BURD'), 'mcp:teamai:BURD');
  assert.equal(remoteSecretRef('n8n', 'BURD'), 'mcp:n8n:BURD');
  assert.equal(remoteBrokerEnv('teamai'), 'MD_TEAMAI_MCP_TOKEN');
  assert.equal(remoteBrokerEnv('n8n'), 'MD_N8N_MCP_TOKEN');
  assert.equal(remoteBrokerRoute('teamai'), '/teamai-mcp');
  assert.equal(remoteBrokerRoute('n8n'), '/n8n-mcp');
  assert.equal(remoteBrokerEnv('unknown'), undefined);
  assert.equal(remoteBrokerRoute('unknown'), undefined);
  assert.equal(resolveRemoteProject('unknown', { enabled: true }, 'BURD', 'jim'), null);
});

test('Team AI HTTP URLs allow only literal private IPv4 and loopback', () => {
  for (const url of [
    'http://10.1.2.3/mcp', 'http://172.16.0.1/mcp',
    'http://172.31.255.254/mcp', 'http://172.30.0.7:8080/mcp',
    'http://192.168.1.5/mcp', 'http://100.64.0.1/mcp',
    'http://100.127.255.255/mcp', 'http://localhost:8080/mcp',
    'https://x.example.com/mcp'
  ]) assert.ok(normalizeRemoteUrl('teamai', url), url);
  for (const url of [
    'http://8.8.8.8/mcp', 'http://172.32.0.1/mcp',
    'http://172.15.0.1/mcp', 'http://100.128.0.1/mcp',
    'http://192.169.0.1/mcp', 'http://team.example.com/mcp',
    'http://0x0a000001/mcp', 'http://user:pw@10.0.0.1/mcp',
    'http://169.254.0.1/mcp', 'http://0.0.0.0/mcp',
    'http://127.0.0.2/mcp', 'http://[::1]/mcp',
    'ftp://10.0.0.1/mcp', '', 'not a url'
  ]) assert.equal(normalizeRemoteUrl('teamai', url), null, url);
  assert.equal(normalizeRemoteUrl('n8n', 'http://10.0.0.1/mcp'), null);
  assert.equal(normalizeRemoteUrl('unknown', 'https://x.example.com/mcp'), null);
});

test('Team AI resolution requires per-project consent and a nonempty allow-list', () => {
  const consent = { enabled: true, projects: {
    BURD: { url: 'http://172.30.0.7:8080/mcp', agents: ['jim'] },
    RISTO: { url: 'https://risto.example.com/mcp', agents: ['dwight'] }
  } };
  assert.equal(resolveRemoteProject('teamai', consent, 'BURD', 'jim').url,
    'http://172.30.0.7:8080/mcp');
  for (const [project, agent] of [['BURD', 'dwight'], ['RISTO', 'jim'], ['OTHER', 'jim']])
    assert.equal(resolveRemoteProject('teamai', consent, project, agent), null);
  assert.equal(resolveRemoteProject('teamai', { ...consent, enabled: false }, 'BURD', 'jim'), null);
  assert.equal(resolveRemoteProject('teamai', { enabled: true, projects: { BURD: { url: consent.projects.BURD.url, agents: [] } } }, 'BURD', 'jim'), null);
});

test('spawn grant gives only a broker capability to listed Team AI agents', () => {
  const { remoteSpawnGrant, n8nSpawnGrant } = loadTs('src/main/n8nGrant.ts');
  const consent = { enabled: true, projects: { BURD: { url: 'http://172.30.0.7:8080/mcp', agents: ['jim'] } } };
  let grants = 0;
  const deps = { brokerRunning: () => true, brokerUrl: () => 'http://127.0.0.1:4555',
    hasToken: () => true, grant: () => `cap-${++grants}` };
  assert.deepEqual(remoteSpawnGrant('teamai', deps, consent, 'BURD', 'jim'), {
    url: 'http://127.0.0.1:4555/teamai-mcp', env: { MD_TEAMAI_MCP_TOKEN: 'cap-1' }
  });
  assert.equal(remoteSpawnGrant('teamai', deps, consent, 'BURD', 'dwight'), undefined);
  assert.equal(remoteSpawnGrant('teamai', { ...deps, hasToken: () => false }, consent, 'BURD', 'jim'), undefined);
  assert.equal(remoteSpawnGrant('teamai', { ...deps, brokerRunning: () => false }, consent, 'BURD', 'jim'), undefined);
  assert.equal(remoteSpawnGrant('unknown', deps, consent, 'BURD', 'jim'), undefined);
  assert.equal(n8nSpawnGrant(deps, consent, 'BURD', 'jim'), undefined, 'n8n keeps its HTTPS-only rule');
  assert.equal(grants, 1);
});

test('broker keeps remote capabilities separate and neither is writable', async () => {
  const { createServer } = require('node:http');
  const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
  const seen = [];
  const upstream = (id) => createServer((req, res) => {
    seen.push({ id, authorization: req.headers.authorization, path: req.url });
    res.end(JSON.stringify({ id }));
  });
  const n8n = upstream('n8n');
  const teamai = upstream('teamai');
  await Promise.all([new Promise((r) => n8n.listen(0, '127.0.0.1', r)),
    new Promise((r) => teamai.listen(0, '127.0.0.1', r))]);
  const n8nUrl = `http://127.0.0.1:${n8n.address().port}/mcp`;
  const teamaiUrl = `http://127.0.0.1:${teamai.address().port}/mcp`;
  const broker = new IntegrationBroker({
    getRecord: () => undefined, getSecret: () => undefined,
    n8nUpstream: () => ({ url: n8nUrl, token: 'TOKEN_N8N_X' }),
    remoteUpstream: (id) => id === 'teamai' ? { url: teamaiUrl, token: 'TOKEN_TEAMAI_Y' } : undefined
  });
  await broker.start();
  const call = (route, cap) => fetch(broker.url() + route, {
    method: 'POST', redirect: 'manual', body: '{}', headers: { 'X-MD-Broker-Token': cap }
  });
  try {
    const n8nCap = broker.grantN8n('jim', 'BURD');
    const teamaiCap = broker.grantRemote('teamai', 'jim', 'BURD');
    assert.ok(teamaiCap && teamaiCap !== n8nCap);
    assert.equal(broker.hasWritableCapability(teamaiCap), false);
    assert.equal(broker.hasWritableCapability(n8nCap), false);
    assert.equal((await call('/n8n-mcp', n8nCap)).status, 200);
    assert.equal((await call('/teamai-mcp', teamaiCap)).status, 200);
    assert.deepEqual(seen.map((x) => [x.id, x.authorization]), [
      ['n8n', 'Bearer TOKEN_N8N_X'], ['teamai', 'Bearer TOKEN_TEAMAI_Y']
    ]);
    assert.equal((await call('/n8n-mcp', teamaiCap)).status, 403);
    assert.equal((await call('/teamai-mcp', n8nCap)).status, 403);
    assert.equal((await call('/automations', teamaiCap)).status, 403);
    assert.equal(seen.length, 2, 'cross-route requests reached neither upstream');
    broker.revokeRemote('teamai', 'jim');
    assert.equal((await call('/teamai-mcp', teamaiCap)).status, 401);
    assert.equal((await call('/n8n-mcp', n8nCap)).status, 200);
    const teamaiCap2 = broker.grantRemote('teamai', 'jim', 'BURD');
    broker.revoke('jim');
    assert.equal((await call('/teamai-mcp', teamaiCap2)).status, 401);
    assert.equal((await call('/n8n-mcp', n8nCap)).status, 401);
    assert.equal(broker.grantRemote('unknown', 'jim', 'BURD'), undefined);
  } finally {
    broker.stop(); n8n.closeAllConnections(); teamai.closeAllConnections();
    n8n.close(); teamai.close();
  }
});
