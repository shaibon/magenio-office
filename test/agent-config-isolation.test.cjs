'use strict';

/**
 * Hook-bearing config lives outside every agent-writable root (t-279, Creed HIGH #2):
 * Claude's --settings file and Codex's CODEX_HOME/config.toml name the command that runs in
 * the agent's own process, so a peer able to rewrite them gets code execution there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

function env(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-acfg-'));
  const home = path.join(base, 'home');
  const harness = path.join(base, 'harness');
  const appData = path.join(base, 'appdata');
  for (const d of [home, harness, appData]) fs.mkdirSync(d, { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = prev; fs.rmSync(base, { recursive: true, force: true }); });
  return { home, harness, appData, hive: path.join(harness, 'hive') };
}

function filesUnder(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

test('legacy hive-side .codex and settings.json migrate to the app-owned dir; sessions and index survive', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.ensureHive();
  m.writeJson(path.join(e.hive, 'registry.json'), { godId: null, agents: { a1: { id: 'a1', name: 'A1', provider: 'codex', cwd: e.harness } } });
  const legacy = path.join(e.hive, 'agents', 'a1');
  fs.mkdirSync(path.join(legacy, '.codex', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(legacy, '.codex', 'config.toml'), '[[hooks.Stop]]\ncommand = "evil"\n');
  fs.writeFileSync(path.join(legacy, '.codex', 'state_5.sqlite'), 'INDEX');
  fs.writeFileSync(path.join(legacy, '.codex', 'sessions', 'rollout-x.jsonl'), 'ROLL');
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"hooks":{}}');

  m.ensureHive();

  const cfg = m.agentConfigDir('a1');
  assert.ok(cfg && !cfg.startsWith(e.harness), 'config dir is outside the hive');
  assert.equal(fs.readFileSync(path.join(cfg, '.codex', 'state_5.sqlite'), 'utf8'), 'INDEX');
  assert.ok(fs.existsSync(path.join(cfg, '.codex', 'sessions')) || fs.lstatSync(path.join(cfg, '.codex', 'sessions')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(legacy, '.codex')), false, 'legacy codex home gone');
  assert.equal(fs.existsSync(path.join(legacy, 'settings.json')), false, 'legacy claude settings gone');
});

test('migration is idempotent and never leaves a hook-bearing legacy config next to a migrated one', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.ensureHive();
  const cfg = m.agentConfigDir('a1');
  fs.mkdirSync(path.join(cfg, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(cfg, '.codex', 'config.toml'), 'GOOD');
  const legacy = path.join(e.hive, 'agents', 'a1', '.codex');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.toml'), 'EVIL');
  m.migrateAgentConfig('a1');
  m.migrateAgentConfig('a1');
  assert.equal(fs.readFileSync(path.join(cfg, '.codex', 'config.toml'), 'utf8'), 'GOOD');
  assert.equal(fs.existsSync(path.join(legacy, 'config.toml')), false);
});

test('after a codex spawn no hook-bearing file exists anywhere under the hive', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.codexHookLister = () => [];
  m.ensureHive();
  const agentDir = path.join(e.hive, 'agents', 'a1');
  fs.mkdirSync(agentDir, { recursive: true });
  const home = m.installCodexHooks(agentDir, 'a1');
  assert.ok(home.startsWith(path.join(e.home, '.mdagents')), 'codex home is app-owned');
  const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.match(toml, /hooks\.Stop/);
  assert.match(toml, /hook-node/, 'hook runs under the app-owned launcher');
  assert.ok(!toml.includes(e.hive), 'hook command never points into the hive');
  for (const f of filesUnder(e.hive)) {
    const txt = fs.readFileSync(f, 'utf8');
    assert.ok(!/cth-hook|hook-node/.test(txt), `hook-bearing file under the hive: ${f}`);
  }
});

test('headless (no app data dir): legacy location, no token', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness);
  assert.equal(m.agentConfigDir('a1'), null);
  assert.equal(m.spawnHookToken('a1'), undefined);
});

test('agent ids cannot escape the config root', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  for (const bad of ['../x', 'a/b', '..', '.', '']) assert.equal(m.agentConfigDir(bad), null, bad);
});

test('claude --settings is written under the app-owned dir, never under the hive', async (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  const inj = await m.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: e.harness });
  const i = inj.args.indexOf('--settings');
  assert.ok(i >= 0, '--settings passed');
  const settings = inj.args[i + 1];
  assert.ok(settings.startsWith(path.join(e.home, '.mdagents')), settings);
  assert.ok(!fs.existsSync(path.join(e.hive, 'agents', 'a1', 'settings.json')));
  assert.match(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command, /hook-node/);
  assert.ok(inj.env.HIVE_HOOK_TOKEN, 'token only because the shim is app-owned');
  for (const f of filesUnder(e.hive)) assert.ok(!/cth-hook|hook-node/.test(fs.readFileSync(f, 'utf8')), f);
});

test('purge removes one agent\'s config dir (and only that), reset removes the hive\'s whole config root', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  const a = m.agentConfigDir('a1'), b = m.agentConfigDir('b1');
  for (const d of [a, b]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'settings.json'), '{}'); }
  const other = path.join(e.home, '.mdagents', 'ffffff', 'a1');       // another hive's agent, same id
  fs.mkdirSync(other, { recursive: true });
  m.removeAgentConfig('../b1'); m.removeAgentConfig('..'); m.removeAgentConfig('');
  assert.ok(fs.existsSync(a) && fs.existsSync(b), 'traversal ids remove nothing');
  m.removeAgentConfig('a1');
  assert.ok(!fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(other));
  m.removeAllAgentConfig();
  assert.ok(!fs.existsSync(b) && fs.existsSync(other), 'only this hive\'s root goes');
});

// QA P1: coexisting homes must not strand the old session data.
test('coexisting homes: legacy index and rollouts are merged into the app-owned home', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.ensureHive();
  const target = path.join(m.agentConfigDir('a1'), '.codex');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'config.toml'), 'GOOD');
  const legacy = path.join(e.hive, 'agents', 'a1', '.codex');
  fs.mkdirSync(path.join(legacy, 'sessions', '2026'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.toml'), 'EVIL');
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'INDEX');
  fs.writeFileSync(path.join(legacy, 'sessions', '2026', 'rollout-session.jsonl'), 'ROLL');

  m.migrateAgentConfig('a1');

  assert.equal(fs.readFileSync(path.join(target, 'state_5.sqlite'), 'utf8'), 'INDEX');
  assert.equal(fs.readFileSync(path.join(target, 'sessions', '2026', 'rollout-session.jsonl'), 'utf8'), 'ROLL');
  assert.equal(fs.readFileSync(path.join(target, 'config.toml'), 'utf8'), 'GOOD');
  assert.equal(fs.existsSync(legacy), false, 'fully merged legacy dir is removed');
});

test('two clashing sqlite indexes: the legacy index (which knows the old rollouts) becomes active, the target one is kept aside', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.ensureHive();
  const target = path.join(m.agentConfigDir('a1'), '.codex');
  const legacy = path.join(e.hive, 'agents', 'a1', '.codex');
  const OLD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(target, 'state_5.sqlite'), 'NEW-only');
  fs.writeFileSync(path.join(target, 'state_5.sqlite-wal'), 'NEW-wal');       // stale wal must not meet the old db
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'index ' + OLD);
  fs.writeFileSync(path.join(legacy, 'sessions', `rollout-${OLD}.jsonl`), 'ROLL');

  m.migrateAgentConfig('a1');

  assert.ok(fs.readFileSync(path.join(target, 'state_5.sqlite')).includes(Buffer.from(OLD)), 'active db indexes the old session');
  assert.equal(fs.existsSync(path.join(target, 'state_5.sqlite-wal')), false, 'target wal never paired with the legacy db');
  assert.equal(fs.readFileSync(path.join(target, 'sessions', `rollout-${OLD}.jsonl`), 'utf8'), 'ROLL');
  const aside = fs.readdirSync(target).filter((n) => n.startsWith('state_5.sqlite') && n.includes('.superseded-'));
  assert.equal(aside.length, 2, 'target db + wal kept, not deleted');
  assert.equal(fs.readFileSync(path.join(target, aside.find((n) => !n.includes('-wal')))).toString(), 'NEW-only');
  assert.equal(fs.existsSync(legacy), false, 'nothing left behind');
  assert.match(fs.readFileSync(path.join(e.hive, 'log.jsonl'), 'utf8'), /agent-config-db-swapped/);
});

test('a clashing NON-db file is never overwritten or deleted, and is logged', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.ensureHive();
  const target = path.join(m.agentConfigDir('a1'), '.codex');
  const legacy = path.join(e.hive, 'agents', 'a1', '.codex');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(target, 'history.jsonl'), 'NEW');
  fs.writeFileSync(path.join(legacy, 'history.jsonl'), 'OLD');
  m.migrateAgentConfig('a1');
  assert.equal(fs.readFileSync(path.join(target, 'history.jsonl'), 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(path.join(legacy, 'history.jsonl'), 'utf8'), 'OLD');
  assert.match(fs.readFileSync(path.join(e.hive, 'log.jsonl'), 'utf8'), /agent-config-migration-conflict/);
});

test('an interrupted staged copy is discarded; the intact legacy home migrates on the next run', (t) => {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.ensureHive();
  const cfg = m.agentConfigDir('a1');
  fs.mkdirSync(path.join(cfg, '.codex.migrating'), { recursive: true });
  fs.writeFileSync(path.join(cfg, '.codex.migrating', 'partial'), 'x');
  const legacy = path.join(e.hive, 'agents', 'a1', '.codex');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'INDEX');
  m.migrateAgentConfig('a1');
  assert.equal(fs.readFileSync(path.join(cfg, '.codex', 'state_5.sqlite'), 'utf8'), 'INDEX');
  assert.equal(fs.existsSync(path.join(cfg, '.codex.migrating')), false);
});

// QA P1: partial sqlite families must never mix a database with a foreign WAL.
function partial(t, tFiles, lFiles) {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.ensureHive();
  const target = path.join(m.agentConfigDir('a1'), '.codex');
  const legacy = path.join(e.hive, 'agents', 'a1', '.codex');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  for (const [n, c] of Object.entries(tFiles)) fs.writeFileSync(path.join(target, n), c);
  for (const [n, c] of Object.entries(lFiles)) fs.writeFileSync(path.join(legacy, n), c);
  m.migrateAgentConfig('a1');
  const read = (n) => (fs.existsSync(path.join(target, n)) ? fs.readFileSync(path.join(target, n), 'utf8') : null);
  const names = fs.readdirSync(target);
  return { e, target, legacy, read, names, log: fs.readFileSync(path.join(e.hive, 'log.jsonl'), 'utf8') };
}

test('target db + legacy-only wal: the orphan wal is parked unpaired, never attached to the target db', (t) => {
  const r = partial(t, { 'state_5.sqlite': 'TARGET-DB' }, { 'state_5.sqlite-wal': 'LEGACY-WAL' });
  assert.equal(r.read('state_5.sqlite'), 'TARGET-DB');
  assert.equal(r.read('state_5.sqlite-wal'), null, 'no live wal next to the target db');
  assert.ok(r.names.some((n) => n.startsWith('state_5.sqlite-wal.orphan-')));
  assert.match(r.log, /agent-config-db-orphan/);
  assert.equal(fs.existsSync(r.legacy), false);
});

test('legacy db only (no wal) vs target db + wal: the family swaps as a unit', (t) => {
  const r = partial(t, { 'state_5.sqlite': 'T-DB', 'state_5.sqlite-wal': 'T-WAL' }, { 'state_5.sqlite': 'L-DB' });
  assert.equal(r.read('state_5.sqlite'), 'L-DB');
  assert.equal(r.read('state_5.sqlite-wal'), null, 'target wal not left against the legacy db');
  assert.equal(r.names.filter((n) => n.includes('.superseded-')).length, 2);
  assert.match(r.log, /agent-config-db-swapped/);
});

test('legacy wal-only with no target db: parked as orphan, not moved in as a live wal', (t) => {
  const r = partial(t, {}, { 'state_5.sqlite-wal': 'LEGACY-WAL' });
  assert.equal(r.read('state_5.sqlite-wal'), null);
  assert.ok(r.names.some((n) => n.includes('.orphan-')));
});

test('legacy full family, target has none: moves intact as a unit', (t) => {
  const r = partial(t, {}, { 'state_5.sqlite': 'L-DB', 'state_5.sqlite-wal': 'L-WAL' });
  assert.equal(r.read('state_5.sqlite'), 'L-DB');
  assert.equal(r.read('state_5.sqlite-wal'), 'L-WAL');
});
