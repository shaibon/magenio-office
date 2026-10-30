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

const OLDID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function setup(t, id = 'a1') {
  const e = env(t);
  const m = new HiveManager(() => e.harness, undefined, () => e.appData);
  m.ensureHive();
  const legacy = path.join(e.hive, 'agents', id, '.codex');
  fs.mkdirSync(legacy, { recursive: true });
  const cfg = m.agentConfigDir(id);
  const target = path.join(cfg, '.codex');
  const log = () => fs.readFileSync(path.join(e.hive, 'log.jsonl'), 'utf8');
  return { e, m, legacy, cfg, target, log };
}

test('legacy codex DATA migrates once (index, sessions, history); config/settings stay behind, nothing is deleted in the hive', (t) => {
  const { e, m, legacy, cfg, target } = setup(t);
  fs.mkdirSync(path.join(legacy, 'sessions', '2026'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.toml'), '[[hooks.Stop]]\ncommand = "evil"\n');
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'INDEX ' + OLDID);
  fs.writeFileSync(path.join(legacy, 'history.jsonl'), 'H');
  fs.writeFileSync(path.join(legacy, 'sessions', '2026', `rollout-${OLDID}.jsonl`), 'ROLL');
  fs.writeFileSync(path.join(e.hive, 'agents', 'a1', 'settings.json'), '{"hooks":{}}');

  m.migrateAgentConfig('a1');

  assert.ok(cfg && !cfg.startsWith(e.harness));
  assert.ok(fs.readFileSync(path.join(target, 'state_5.sqlite')).includes(Buffer.from(OLDID)));
  assert.equal(fs.readFileSync(path.join(target, 'sessions', '2026', `rollout-${OLDID}.jsonl`), 'utf8'), 'ROLL');
  assert.equal(fs.readFileSync(path.join(target, 'history.jsonl'), 'utf8'), 'H');
  assert.equal(fs.existsSync(path.join(target, 'config.toml')), false, 'legacy config.toml is never imported');
  assert.ok(fs.existsSync(path.join(legacy, 'config.toml')), 'and never deleted from the peer-writable tree either');
  assert.ok(fs.existsSync(path.join(e.hive, 'agents', 'a1', 'settings.json')));
  assert.ok(fs.existsSync(path.join(cfg, '.migrated')));
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o700);
});

test('F1: a legacy tree recreated after the migration is inert (marker): nothing is imported again', (t) => {
  const { m, legacy, target } = setup(t);
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'GOOD');
  m.migrateAgentConfig('a1');
  fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'skills', 'evil.md'), 'x');
  fs.writeFileSync(path.join(legacy, 'config.toml'), 'EVIL');
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'EVIL-DB');
  m.migrateAgentConfig('a1'); m.migrateAgentConfig('a1');
  assert.equal(fs.readFileSync(path.join(target, 'state_5.sqlite'), 'utf8'), 'GOOD');
  assert.equal(fs.existsSync(path.join(target, 'skills')), false);
  assert.equal(fs.existsSync(path.join(target, 'config.toml')), false);
});

test('F1: a planted .hook-trust.json, skills, rules, AGENTS.md and links are never imported on the first run either', (t) => {
  const { m, legacy, target } = setup(t);
  fs.writeFileSync(path.join(legacy, '.hook-trust.json'), '{"sig":"x","toml":"[mcp_servers.evil]"}');
  fs.mkdirSync(path.join(legacy, 'skills')); fs.writeFileSync(path.join(legacy, 'skills', 's.md'), 'x');
  fs.mkdirSync(path.join(legacy, 'rules')); fs.writeFileSync(path.join(legacy, 'AGENTS.md'), 'obey');
  fs.symlinkSync('/etc', path.join(legacy, 'packages'));
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'DB');
  m.migrateAgentConfig('a1');
  assert.deepEqual(fs.readdirSync(target).sort(), ['state_5.sqlite']);
});

test('F1/F2: legacy .codex that is a symlink (to the hive or to an external dir) is refused and the target is left intact', (t) => {
  for (const kind of ['hive', 'external']) {
    const { e, m, legacy, cfg, target, log } = setup(t, 'a' + kind);
    fs.rmSync(legacy, { recursive: true });
    const dest = kind === 'hive' ? path.join(e.hive, 'agents', 'victim-dir') : path.join(e.home, '.ssh');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'config.toml'), 'REAL-USER-FILE');
    fs.writeFileSync(path.join(dest, 'state_5.sqlite'), 'REAL-USER-DB');
    fs.writeFileSync(path.join(dest, 'id_rsa'), 'KEY');
    fs.symlinkSync(dest, legacy, 'dir');
    m.migrateAgentConfig('a' + kind);
    assert.equal(fs.readFileSync(path.join(dest, 'config.toml'), 'utf8'), 'REAL-USER-FILE', 'external file survives');
    assert.equal(fs.readFileSync(path.join(dest, 'state_5.sqlite'), 'utf8'), 'REAL-USER-DB', 'nothing was moved out of the link target');
    assert.equal(fs.readFileSync(path.join(dest, 'id_rsa'), 'utf8'), 'KEY');
    assert.equal(fs.existsSync(target) ? fs.readdirSync(target).length : 0, 0, 'target got nothing');
    assert.ok(fs.lstatSync(legacy).isSymbolicLink(), 'the link itself is untouched');
    assert.match(log(), /agent-config-migration-refused/);
    assert.ok(fs.existsSync(path.join(cfg, '.migrated')));
  }
});

test('F2: a symlinked agent dir is refused', (t) => {
  const { e, m, log } = setup(t, 'a1');
  const real = path.join(e.home, 'elsewhere');
  fs.mkdirSync(path.join(real, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(real, '.codex', 'state_5.sqlite'), 'USER-DB');
  fs.rmSync(path.join(e.hive, 'agents', 'a1'), { recursive: true });
  fs.symlinkSync(real, path.join(e.hive, 'agents', 'a1'), 'dir');
  m.migrateAgentConfig('a1');
  assert.equal(fs.readFileSync(path.join(real, '.codex', 'state_5.sqlite'), 'utf8'), 'USER-DB');
  assert.match(log(), /legacy-agent-dir/);
});

test('F2: symlinks INSIDE sessions are never followed or moved; the exposure link must resolve under the munder scan root', (t) => {
  const { e, m, legacy, target, log } = setup(t);
  const outside = path.join(e.home, 'secret'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'k'), 'S');
  fs.mkdirSync(path.join(legacy, 'sessions'));
  fs.symlinkSync(outside, path.join(legacy, 'sessions', 'x'), 'dir');
  fs.writeFileSync(path.join(legacy, 'sessions', 'r.jsonl'), 'R');
  fs.symlinkSync(outside, path.join(legacy, 'archived_sessions'), 'dir');      // link to a dir outside the scan root
  m.migrateAgentConfig('a1');
  assert.equal(fs.readFileSync(path.join(target, 'sessions', 'r.jsonl'), 'utf8'), 'R');
  assert.equal(fs.existsSync(path.join(target, 'sessions', 'x')), false, 'inner link not carried');
  assert.equal(fs.existsSync(path.join(target, 'archived_sessions')), false, 'out-of-scope exposure link ignored');
  assert.equal(fs.readFileSync(path.join(outside, 'k'), 'utf8'), 'S');
  assert.match(log(), /agent-config-migration-refused/);
  // the legit exposure link (into ~/.codex/sessions/munder-difflin) does move
  const s2 = setup(t, 'a2');
  const scan = path.join(s2.e.home, '.codex', 'sessions', 'munder-difflin', 'h', 'a2');
  fs.mkdirSync(scan, { recursive: true }); fs.writeFileSync(path.join(scan, 'rollout.jsonl'), 'R2');
  fs.symlinkSync(scan, path.join(s2.legacy, 'sessions'), 'dir');
  s2.m.migrateAgentConfig('a2');
  assert.ok(fs.lstatSync(path.join(s2.target, 'sessions')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(s2.target, 'sessions', 'rollout.jsonl'), 'utf8'), 'R2');
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

test('coexisting homes: legacy index and rollouts merge into the app-owned home (first migration only)', (t) => {
  const { m, legacy, target } = setup(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'config.toml'), 'GOOD');
  fs.mkdirSync(path.join(legacy, 'sessions', '2026'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'INDEX');
  fs.writeFileSync(path.join(legacy, 'sessions', '2026', 'rollout-session.jsonl'), 'ROLL');
  m.migrateAgentConfig('a1');
  assert.equal(fs.readFileSync(path.join(target, 'state_5.sqlite'), 'utf8'), 'INDEX');
  assert.equal(fs.readFileSync(path.join(target, 'sessions', '2026', 'rollout-session.jsonl'), 'utf8'), 'ROLL');
  assert.equal(fs.readFileSync(path.join(target, 'config.toml'), 'utf8'), 'GOOD');
});

test('two clashing sqlite indexes: legacy index becomes active, the target one is kept aside', (t) => {
  const { m, legacy, target, log } = setup(t);
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(target, 'state_5.sqlite'), 'NEW-only');
  fs.writeFileSync(path.join(target, 'state_5.sqlite-wal'), 'NEW-wal');
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'index ' + OLDID);
  fs.writeFileSync(path.join(legacy, 'sessions', `rollout-${OLDID}.jsonl`), 'ROLL');
  m.migrateAgentConfig('a1');
  assert.ok(fs.readFileSync(path.join(target, 'state_5.sqlite')).includes(Buffer.from(OLDID)));
  assert.equal(fs.existsSync(path.join(target, 'state_5.sqlite-wal')), false);
  const aside = fs.readdirSync(target).filter((n) => n.includes('.superseded-'));
  assert.equal(aside.length, 2);
  assert.match(log(), /agent-config-db-swapped/);
});

test('a clashing plain data file is never overwritten, and is logged', (t) => {
  const { m, legacy, target, log } = setup(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'history.jsonl'), 'NEW');
  fs.writeFileSync(path.join(legacy, 'history.jsonl'), 'OLD');
  m.migrateAgentConfig('a1');
  assert.equal(fs.readFileSync(path.join(target, 'history.jsonl'), 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(path.join(legacy, 'history.jsonl'), 'utf8'), 'OLD');
  assert.match(log(), /agent-config-migration-conflict/);
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
