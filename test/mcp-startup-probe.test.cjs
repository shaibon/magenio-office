/**
 * t-069 — a `munder-*` MCP server that dies at startup must not be invisible.
 *
 * Two layers, because they fail differently:
 *   1. `probeStdioServer` — the child-process probe itself, driven against tiny
 *      synthetic servers (one that comes up, one that refuses its config, one that
 *      does not exist). No dependency on magenio-mcp being installed.
 *   2. The wiring in `buildDefaultMcpServers` / the spawn path, driven through the
 *      real HiveManager with the probe stubbed, so the assertions are about the
 *      mount decision, the hive log and the degradation notice rather than about a
 *      400ms child process.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const NODE = process.execPath;
const tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const { probeStdioServer, clearProbeCache, redactSecretValues, condenseDetail } =
  loadTs('src/main/mcpProbe.ts');

/** A config file whose fingerprint (size) we can change to invalidate the cache. */
function writeConfig(dir, body) {
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, body);
  return p;
}

/** A synthetic MCP server: a script that prints `stderr` and exits with `code`. */
function fakeServer(dir, name, stderr, code) {
  const p = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(p, `console.error(${JSON.stringify(stderr)}); process.exit(${code});\n`);
  return p;
}

test('a server that comes up is reported healthy', () => {
  const dir = tmp('md-probe-ok-');
  const server = fakeServer(dir, 'healthy', 'fake-mcp: ready on stdio', 0);
  const r = probeStdioServer({ command: NODE, args: [server] });
  assert.equal(r.ok, true);
});

test('a server that refuses its config is reported dead, with its own message', () => {
  const dir = tmp('md-probe-bad-');
  const cfg = writeConfig(dir, '{"ssh":{"password":"hunter2"}}');
  const server = fakeServer(dir, 'broken', 'Invalid config:\nssh: Unrecognized key: "password"', 1);
  const r = probeStdioServer({ command: NODE, args: [server, '--config', cfg] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exit');
  // The server's own verdict survives — that is the whole point of not
  // re-implementing the schema in the app.
  assert.match(r.detail, /ssh: Unrecognized key: "password"/);
});

test('a command that cannot be spawned is reported dead, not thrown', () => {
  const r = probeStdioServer({ command: path.join(os.tmpdir(), 'md-nope-does-not-exist'), args: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'spawn-failed');
});

test('a server terminated by a signal is reported dead', () => {
  const r = probeStdioServer({ command: NODE, args: ['-e', 'process.kill(process.pid, "SIGTERM")'] }, { noCache: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exit');
});

test('a verdict is cached per command line + file fingerprint', () => {
  const dir = tmp('md-probe-cache-');
  const counter = path.join(dir, 'count');
  const cfg = writeConfig(dir, '{"a":1}');
  const server = path.join(dir, 'counted.cjs');
  fs.writeFileSync(server, `require('node:fs').appendFileSync(process.env.PROBE_COUNTER, 'x'); process.exit(0);\n`);
  const spec = { command: NODE, args: [server, '--config', cfg], env: { PROBE_COUNTER: counter } };
  clearProbeCache();

  assert.equal(probeStdioServer(spec).ok, true);
  assert.equal(probeStdioServer(spec).ok, true);
  assert.equal(fs.readFileSync(counter, 'utf8'), 'x', 'the second call must not re-run the child');

  // Editing the config changes its fingerprint → the stale verdict must be dropped.
  writeConfig(dir, '{"a":123456}');
  probeStdioServer(spec);
  assert.equal(fs.readFileSync(counter, 'utf8'), 'xx');
});

test('redactSecretValues masks values but never the field name in a message', () => {
  // The message we WANT to keep — the secret word here is the diagnosis itself.
  assert.equal(
    redactSecretValues('ssh: Unrecognized key: "password"'),
    'ssh: Unrecognized key: "password"'
  );
  const json = redactSecretValues('{"db":{"password":"hunter2","token":"tk_123"}}');
  assert.doesNotMatch(json, /hunter2|tk_123/);
  const toml = redactSecretValues('ssh.password = "hunter2"');
  assert.doesNotMatch(toml, /hunter2/);
});

test('condenseDetail keeps the first lines and caps the length', () => {
  assert.equal(condenseDetail('\n  First \n\n Second \n Third\n'), 'First | Second');
  assert.equal(condenseDetail(undefined), '');
  assert.ok(condenseDetail('x'.repeat(900)).length <= 401);
});

// — wiring: the mount decision, the hive log, the degradation notice —

const userData = tmp('md-probe-hive-');
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};
const { HiveManager } = loadTs('src/main/hive.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

const ALL_OFF = Object.fromEntries(MCP_CATALOG.map((e) => [e.id, { enabled: false }]));

/** HiveManager.root() is `<harnessHome>/hive` — the harness home is the tmp dir,
 *  the hive root (where log.jsonl lands) is its `hive/` child. */
const hiveHome = tmp('md-probe-root-');
const hiveRoot = path.join(hiveHome, 'hive');
fs.mkdirSync(path.join(hiveRoot, 'agents'), { recursive: true });
const emitted = [];
const hive = new HiveManager(() => hiveHome, (channel, payload) => { emitted.push({ channel, payload }); });

const CWD = tmp('md-probe-cwd-');
fs.writeFileSync(path.join(CWD, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');

/** A fully installed user-configured server on disk, so checkMcpPresence passes. */
function installedServer() {
  const root = tmp('md-probe-pkg-');
  const entry = path.join(root, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// server');
  const command = path.join(root, 'node');
  fs.writeFileSync(command, '#!/bin/sh\n');
  fs.chmodSync(command, 0o755);
  return { command, args: [entry] };
}

function logLines(kind) {
  const p = path.join(hiveRoot, 'log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.kind === kind);
}

/** What the probe "finds" for the wiring tests below; swapped per test. */
let harnessProbe = { ok: true, alive: false };
hive['probeMcpServerForMount'] = () => harnessProbe;

test('a refused Magento config is NOT mounted, and the reason reaches log.jsonl + the floor', () => {
  const pkg = installedServer();
  const cfgPath = writeConfig(tmp('md-probe-mag-'), '{"ssh":{"password":"hunter2"}}');
  const before = logLines('mcp-server-dead').length;
  harnessProbe = { ok: false, reason: 'exit', detail: 'Invalid config: the server refused this file' };
  emitted.length = 0;

  const map = hive['buildDefaultMcpServers'](
    CWD, { ...ALL_OFF, magento: { enabled: true, ...pkg } }, 'pam-t069', { role: 'pm' }, cfgPath
  );
  assert.equal(map['munder-magento'], undefined, 'a corpse must not be mounted');
  assert.equal(Object.keys(map).length, 0);

  const dead = logLines('mcp-server-dead');
  assert.equal(dead.length, before + 1);
  assert.equal(dead[dead.length - 1].agentId, 'pam-t069');
  assert.equal(dead[dead.length - 1].server, 'munder-magento');
  assert.match(dead[dead.length - 1].detail, /refused this file/);
  assert.ok(dead[dead.length - 1].detail.includes(cfgPath), 'the log must name the file to fix');

  const pushed = emitted.filter((e) => e.channel === 'hive:degraded' && e.payload.reason === 'mcp-mount-refused');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.server, 'munder-magento');

  // One spawn builds the map two or three times; that is ONE breakage, not three.
  hive['buildDefaultMcpServers'](CWD, { ...ALL_OFF, magento: { enabled: true, ...pkg } }, 'pam-t069', { role: 'pm' }, cfgPath);
  hive['buildDefaultMcpServers'](CWD, { ...ALL_OFF, magento: { enabled: true, ...pkg } }, 'pam-t069', { role: 'pm' }, cfgPath);
  assert.equal(logLines('mcp-server-dead').length, before + 1, 'announced once per spawn');

  const note = hive['mcpDegradationNote']('pam-t069', 'Pam');
  assert.match(note, /^Pam is running without munder-magento/);
  assert.match(note, /Fix that config and respawn/);
  assert.equal(hive['mcpDegradationNote']('someone-else', 'Dwight'), '', 'no failures → no notice');
});

test('a healthy Magento config is mounted with the project binding as --config', () => {
  const pkg = installedServer();
  const cfgPath = writeConfig(tmp('md-probe-mag2-'), '{"ssh":{"user":"probe"}}');
  harnessProbe = { ok: true, alive: false };

  const map = hive['buildDefaultMcpServers'](
    CWD, { ...ALL_OFF, magento: { enabled: true, ...pkg } }, 'pam-t069b', { role: 'pm' }, cfgPath
  );
  assert.deepEqual(map['munder-magento'], { command: pkg.command, args: [pkg.args[0], '--config', cfgPath] });
  assert.equal(hive['mcpDegradationNote']('pam-t069b', 'Pam'), '');
});

test('a later spawn does not report an earlier MCP failure', async () => {
  const pkg = installedServer();
  const cfgPath = writeConfig(tmp('md-probe-stale-'), '{"broken":true}');
  harnessProbe = { ok: false, reason: 'exit', detail: 'Invalid config' };
  hive['buildDefaultMcpServers'](
    CWD, { ...ALL_OFF, magento: { enabled: true, ...pkg } }, 'pam-stale', { role: 'pm' }, cfgPath
  );
  assert.match(hive['mcpDegradationNote']('pam-stale', 'Pam'), /munder-magento/);

  const injection = await hive.ensureAgent(
    { id: 'pam-stale', name: 'Pam', provider: 'claude', cwd: CWD },
    { mcpDefaults: ALL_OFF }
  );
  assert.equal(injection.degraded, undefined);

  const before = logLines('mcp-server-dead').length;
  hive['buildDefaultMcpServers'](
    CWD, { ...ALL_OFF, magento: { enabled: true, ...pkg } }, 'pam-stale', { role: 'pm' }, cfgPath
  );
  assert.equal(logLines('mcp-server-dead').length, before + 1, 'a new spawn can announce a new refusal');
});
