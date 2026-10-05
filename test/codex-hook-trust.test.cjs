'use strict';

// Codex runs only hooks whose hash is recorded as trusted. Since Remote Control the
// session lives in a daemon that never saw --dangerously-bypass-hook-trust, so our
// hooks were skipped in silence. These pin the fix: trust is written into config.toml
// (from codex's own hashes), only for OUR hooks, failure is loud, and the shim logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hook-trust-'));
process.env.HOME = base; // installCodexHooks reads ~/.codex: keep it hermetic
const ep = require.resolve('electron');
require.cache[ep] = { id: ep, filename: ep, loaded: true, exports: { app: { getPath: () => base, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } } };
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const { hookTrustToml, parseHooksList } = loadTs('src/main/codexHookTrust.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const H = (c) => 'sha256:' + c.repeat(64);

test('hookTrustToml trusts exactly the hooks that run our shim, from codex\'s own hash', () => {
  const shim = '/hive/bin/cth-hook.cjs';
  const toml = hookTrustToml([
    { key: '/h/config.toml:pre_tool_use:0:0', command: `"/hive/bin/hive-node" "${shim}"`, currentHash: H('a') },
    { key: '/h/config.toml:stop:0:0', command: `"/hive/bin/hive-node" "${shim}"`, currentHash: H('b') },
    { key: '/h/config.toml:session_start:0:0', command: 'sh /home/user/own-hook.sh', currentHash: H('c') },   // the user's own: not ours
    { key: 'plugin:x', command: `"${shim}"`, currentHash: 'not-a-hash' }                                      // malformed hash: skipped
  ], shim);
  assert.match(toml, /\[hooks\.state\."\/h\/config\.toml:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:a{64}"/);
  assert.match(toml, /\[hooks\.state\."\/h\/config\.toml:stop:0:0"\]\ntrusted_hash = "sha256:b{64}"/);
  assert.doesNotMatch(toml, /own-hook|session_start|plugin:x/);
});

test('parseHooksList reads codex\'s reply and ignores anything else', () => {
  const line = JSON.stringify({ id: 2, result: { data: [{ cwd: '/x', hooks: [{ key: 'k', currentHash: H('d'), command: 'c' }] }] } });
  assert.deepEqual(parseHooksList(line).map((h) => h.key), ['k']);
  assert.deepEqual(parseHooksList('not json'), []);
  assert.deepEqual(parseHooksList('{"id":2,"error":{}}'), []);
});

function setup(lister) {
  const root = fs.mkdtempSync(path.join(base, 'hive-'));
  const hive = new HiveManager(() => root);
  hive.ensureHive();
  const logs = [];
  hive.appendLog = (e) => logs.push(e);
  const hiveRoot = hive.root(); // <harnessHome>/hive
  hive.codexHookLister = lister(hiveRoot);
  const dir = path.join(hiveRoot, 'agents', 'a1');
  fs.mkdirSync(dir, { recursive: true });
  return { hive, root: hiveRoot, dir, logs };
}
const listerFor = (calls) => (root) => (home) => {
  calls.push(home);
  const shim = path.join(root, 'bin', 'cth-hook.cjs');
  const cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  // Behave like codex: one entry per generated hook, hash derived from its position.
  return [...cfg.matchAll(/^\[\[hooks\.(\w+)\.hooks\]\]/gm)].map((m, i) => ({
    key: `${home}/config.toml:${m[1].toLowerCase()}:0:0`, command: `"${shim}"`, currentHash: H((i % 10).toString())
  }));
};

test('installCodexHooks records trust for every generated hook and reuses it on respawn', () => {
  const calls = [];
  const { hive, dir, logs } = setup(listerFor(calls));
  const home = hive['installCodexHooks'](dir, 'a1', '');
  const cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.equal((cfg.match(/^\[\[hooks\.\w+\]\]/gm) || []).length, 8);
  assert.equal((cfg.match(/^\[hooks\.state\./gm) || []).length, 8);
  assert.ok(cfg.indexOf('[hooks.state.') > cfg.lastIndexOf('[[hooks.'), 'state tables come after the hooks');
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, []);
  hive['installCodexHooks'](dir, 'a1', '');          // identical config: cached, codex is not asked again
  assert.equal(calls.length, 1);
  assert.equal((fs.readFileSync(path.join(home, 'config.toml'), 'utf8').match(/^\[hooks\.state\./gm) || []).length, 8);
});

test('when codex cannot say, the config is still written and the failure is logged loudly', () => {
  const { hive, dir, logs } = setup(() => () => { throw new Error('codex not found'); });
  const home = hive['installCodexHooks'](dir, 'a1', '');
  const cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.equal((cfg.match(/^\[\[hooks\.\w+\]\]/gm) || []).length, 8);
  assert.doesNotMatch(cfg, /hooks\.state/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'codex-hooks-untrusted');
  assert.equal(logs[0].agentId, 'a1');
});

test('the hook shim records a one-line failure instead of failing silently', () => {
  const { root } = setup(() => () => []);
  const shim = path.join(root, 'bin', 'cth-hook.cjs');
  const run = (env) => spawnSync(process.execPath, [shim], { input: '{"hook_event_name":"Stop"}', env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  // Socket missing: connect error is recorded, exit code stays 0 (never blocks the CLI).
  const r = run({ HIVE_SOCK: path.join(root, 'hooks.sock'), AGENT_ID: 'a1' });
  assert.equal(r.status, 0);
  const log = fs.readFileSync(path.join(root, 'hook-failures.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.match(log[0], /agent=a1 connect (ENOENT|ECONNREFUSED)/);
  // No HIVE_SOCK at all is also recorded.
  assert.equal(run({ AGENT_ID: 'a2' }).status, 0);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src/main/hive.ts'), 'utf8'), /fail\('HIVE_SOCK is not set'\)/);
});
