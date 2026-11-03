'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-teamai-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false,
    getAppPath: () => path.join(__dirname, '..') } }
};
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

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

test('Team AI mount requires its own project, allow-list and broker capability', () => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => userData);
  const off = Object.fromEntries(MCP_CATALOG.map((e) => [e.id, { enabled: false }]));
  const teamai = { enabled: true, projects: { BURD: {
    url: 'http://172.30.0.7:8080/mcp', agents: ['jim']
  } } };
  const brokerUrls = { teamai: 'http://127.0.0.1:4555/teamai-mcp' };
  const build = (consent, agent = 'jim', project = 'BURD', urls = brokerUrls) =>
    hive['buildDefaultMcpServers'](userData, { ...off, teamai: consent }, agent,
      { provider: 'claude', project }, undefined, undefined, undefined, undefined, undefined, urls);
  assert.deepEqual(build(teamai)['munder-teamai'], {
    type: 'http', url: brokerUrls.teamai,
    headers: { 'X-MD-Broker-Token': '${MD_TEAMAI_MCP_TOKEN}' }
  });
  for (const [consent, agent, project, urls] of [
    [{ ...teamai, enabled: false }, 'jim', 'BURD', brokerUrls],
    [teamai, 'dwight', 'BURD', brokerUrls],
    [teamai, 'jim', 'RISTO', brokerUrls],
    [{ enabled: true, projects: { BURD: { url: teamai.projects.BURD.url, agents: [] } } }, 'jim', 'BURD', brokerUrls],
    [{ enabled: true, projects: { BURD: { url: 'http://8.8.8.8/mcp', agents: ['jim'] } } }, 'jim', 'BURD', brokerUrls],
    [teamai, 'jim', 'BURD', {}]
  ]) assert.equal(build(consent, agent, project, urls)['munder-teamai'], undefined);
  const note = hive['mcpMountFailures'].get('jim');
  assert.ok(note.some((f) => f.server === 'munder-teamai' && /BURD/.test(f.detail)
    && /bearer token/.test(f.detail) && !f.detail.includes('172.30.0.7')));
  const codex = hive['codexMcpTables']({ id: 'jim', cwd: userData, provider: 'codex', project: 'BURD' },
    { mcpDefaults: { ...off, teamai }, remoteBrokerUrls: brokerUrls });
  assert.match(codex, /\[mcp_servers\.munder-teamai\]/);
  assert.match(codex, /env_http_headers = \{ X-MD-Broker-Token = "MD_TEAMAI_MCP_TOKEN" \}/);
  assert.doesNotMatch(codex, /172\.30\.0\.7|Bearer|TOKEN_TEAMAI_Y/);
});

test('Claude receives Team AI only when mounted; agent files keep no bearer and stay private', async () => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => userData);
  const off = Object.fromEntries(MCP_CATALOG.map((e) => [e.id, { enabled: false }]));
  const teamai = { enabled: true, projects: { BURD: {
    url: 'http://172.30.0.7:8080/mcp', agents: ['teamai-claude', 'teamai-opencode']
  } } };
  const opts = { mcpDefaults: { ...off, teamai },
    remoteBrokerUrls: { teamai: 'http://127.0.0.1:4555/teamai-mcp' } };
  await hive.ensureAgent({ id: 'teamai-claude', name: 'Team AI Claude', provider: 'claude',
    cwd: userData, project: 'BURD' }, opts);
  assert.equal(hive.remoteMounted('teamai', 'teamai-claude'), true);
  assert.equal(hive.n8nMounted('teamai-claude'), false);
  const agentDir = hive['agentDir']('teamai-claude');
  const mcpPath = path.join(agentDir, 'mcp.json');
  const mcp = fs.readFileSync(mcpPath, 'utf8');
  assert.match(mcp, /munder-teamai/);
  assert.match(mcp, /MD_TEAMAI_MCP_TOKEN/);
  assert.equal(fs.statSync(mcpPath).mode & 0o777, 0o600);
  const allFiles = [];
  function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) scan(file);
      else if (item.isFile()) allFiles.push(fs.readFileSync(file).toString());
    }
  }
  scan(agentDir);
  assert.ok(allFiles.every((text) => !text.includes('TOKEN_TEAMAI_Y')));
  await hive.ensureAgent({ id: 'teamai-opencode', name: 'Team AI OpenCode', provider: 'opencode',
    cwd: userData, project: 'BURD' }, opts);
  assert.equal(hive.remoteMounted('teamai', 'teamai-opencode'), false);
});

test('generic token operations reject unknown remotes and never return a bearer', async () => {
  const { createRemoteTokenOps } = loadTs('src/main/remoteTokens.ts');
  const secrets = new Map();
  const checked = [];
  const ops = createRemoteTokenOps({
    setSecret: (ref, token) => { secrets.set(ref, token); return { ok: true }; },
    deleteSecret: (ref) => secrets.delete(ref),
    hasSecret: (ref) => secrets.has(ref),
    getSecret: (ref) => secrets.get(ref),
    urlFor: () => 'http://172.30.0.7:8080/mcp',
    checkToken: async (url, token) => { checked.push({ url, token }); return 'valid'; }
  });
  for (const id of ['unknown', 'trello']) {
    assert.equal(ops.set(id, 'BURD', 'TOKEN_TEAMAI_Y').ok, false);
    assert.equal(ops.has(id, 'BURD'), false);
    assert.equal(await ops.test(id, 'BURD'), 'missing');
  }
  for (const project of ['constructor', '__proto__']) {
    assert.equal(ops.set('teamai', project, 'TOKEN_TEAMAI_Y').ok, false);
    assert.equal(ops.clear('teamai', project).ok, false);
  }
  assert.deepEqual(ops.set('teamai', 'BURD', ''), { ok: true });
  assert.equal(secrets.size, 0);
  assert.deepEqual(ops.set('teamai', 'BURD', 'TOKEN_TEAMAI_Y'), { ok: true });
  assert.equal(secrets.get('mcp:teamai:BURD'), 'TOKEN_TEAMAI_Y');
  assert.equal(ops.has('teamai', 'BURD'), true);
  assert.equal(await ops.test('teamai', 'BURD'), 'valid');
  assert.deepEqual(checked, [{ url: 'http://172.30.0.7:8080/mcp', token: 'TOKEN_TEAMAI_Y' }]);
  assert.deepEqual(ops.clear('teamai', 'BURD'), { ok: true });
  assert.equal(await ops.test('teamai', 'BURD'), 'missing');
  assert.equal(JSON.stringify([ops.set('teamai', 'BURD', 'TOKEN_TEAMAI_Y'),
    ops.has('teamai', 'BURD'), await ops.test('teamai', 'BURD')]).includes('TOKEN_TEAMAI_Y'), false);
});

test('main wires Team AI grants, cleanup and write-only remote IPC', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload/index.ts'), 'utf8');
  assert.ok(/remoteGrantFor\('teamai'|for \(const remote of MCP_CATALOG/.test(main), 'spawn grants catalog remotes');
  assert.ok(/remoteBrokerUrls: remoteBrokerUrls/.test(main), 'passes broker URLs to hive');
  assert.ok(/remoteUpstream:/.test(main), 'wires the remote upstream');
  assert.ok(/revokeRemote\(remoteId, remoteAgentId\)/.test(main), 'revokes unmounted remotes');
  assert.ok(/delete opts\.env\?\.\[remoteBrokerEnv\(remoteId\)!\]/.test(main), 'drops unmounted env');
  for (const method of ['SetToken', 'ClearToken', 'HasToken', 'TestToken']) {
    assert.ok(new RegExp(`mcp:remote${method}`).test(main), `${method} IPC registered`);
    assert.ok(new RegExp(`mcpRemote${method}`).test(preload), `${method} preload exposed`);
  }
  assert.ok(/createRemoteTokenOps\(/.test(main), 'main uses the tested token operations');
});

test('remote settings use per-id projects, token channels and translated hints', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(ui, /config\.mcpDefaults\?\.\[entry\.id\]\?\.projects/);
  assert.match(ui, /writeConsentPatch\(id, n8nProjectOps\.upsert/);
  assert.match(ui, /mcpRemoteSetToken\(id, project, token\)/);
  assert.match(ui, /mcpRemoteHasToken\(id, k\)/);
  assert.match(ui, /mcpRemoteTestToken\(id, project\)/);
  assert.match(ui, /normalizeRemoteUrl\(entry\.id, pe\.url\)/);
  assert.match(ui, /mcpDefaults\.teamaiUrlPlaceholder/);
  assert.match(ui, /mcpDefaults\.teamaiUrlHint/);
  for (const locale of ['en', 'zh-CN', 'ar']) {
    const dict = JSON.parse(fs.readFileSync(path.join(__dirname, `../src/renderer/src/i18n/locales/${locale}.json`)));
    for (const key of ['remoteProjectsHint', 'remoteAgentsHint', 'remoteTokenHint',
      'remoteTokenUnreachable', 'teamaiUrlPlaceholder', 'teamaiUrlHint']) {
      assert.equal(typeof dict.mcpDefaults[key], 'string', `${locale}: ${key}`);
      assert.ok(dict.mcpDefaults[key].trim(), `${locale}: ${key} is empty`);
    }
  }
});
