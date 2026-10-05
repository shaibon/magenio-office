'use strict';

// Vault write path: allow-list, scope, session lock, snapshot discipline. Every test
// builds its own throwaway git repo; the real vault is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const V = require('../resources/vault-mcp.cjs');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

function fixture({ snapshot = 'ok' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-'));
  const root = path.join(base, 'vault');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('01-Projects/Acme/Log.md', '# Log\n');
  put('01-Projects/Acme/Task/T-1.md', 'task');
  put('01-Projects/Other/Log.md', 'other client');
  put('00-Inbox/Inbox.md', '# Inbox\n');
  put('99-System/Protocol.md', 'protocol');
  const script = snapshot === 'ok'
    ? '#!/usr/bin/env bash\nset -e\ncd "$(dirname "$0")/../.."\n[ -d .git ] || git init -q\ngit add -A\ngit -c user.name=t -c user.email=t@t commit -q --allow-empty -m "${1:-snap}"\n'
    : snapshot === 'fail' ? '#!/usr/bin/env bash\nexit 1\n' : null;
  if (script) put('99-System/scripts/sb-snapshot.sh', script);
  sh(root, 'init', '-q'); sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', 'init');
  const lockPath = path.join(base, 'vault-write.lock');            // OUTSIDE the vault
  const scopes = JSON.stringify(['01-Projects/Acme', '99-System', '03-Resources']);
  const mk = (agent) => { const c = V.loadScopes(root, scopes, agent ? { agent, lockPath } : undefined); if (c.write) c.write.waitMs = 400; return c; };
  const log = () => sh(root, 'log', '--format=%s').trim().split('\n');
  return { base, root, lockPath, mk, log, status: () => sh(root, 'status', '--porcelain').trim() };
}
const call = (ctx, name, args) => V.callTool(ctx, name, args);
const begin = (ctx) => call(ctx, 'vault_session_begin', { reason: 'test' });
const end = (ctx) => call(ctx, 'vault_session_end', {});

test('only the allow-listed writer is offered (or accepted for) write tools', () => {
  const f = fixture();
  const ro = f.mk(null), rw = f.mk('angela-1');
  const names = (ctx) => V.handle(ctx, { id: 1, method: 'tools/list' }).result.tools.map((t) => t.name);
  assert.deepEqual(names(ro), ['vault_list', 'vault_read', 'vault_search']);
  assert.deepEqual(names(rw), ['vault_list', 'vault_read', 'vault_search', 'vault_session_begin', 'vault_append', 'vault_write', 'vault_session_end']);
  for (const [tool, args] of [['vault_session_begin', {}], ['vault_append', { path: '01-Projects/Acme/Log.md', text: 'x' }], ['vault_write', { path: '01-Projects/Acme/N.md', content: 'x' }], ['vault_session_end', {}]]) {
    assert.throws(() => call(ro, tool, args), /no write access/, tool);
  }
  assert.equal(fs.readFileSync(path.join(f.root, '01-Projects/Acme/Log.md'), 'utf8'), '# Log\n');
  // No delete or move tool exists at all.
  assert.ok(!V.WRITE_TOOLS.some((t) => /delete|remove|move|rename|unlink/i.test(t.name)));
});

test('the app mounts write access only for a writer, with the lock path outside the vault', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(src, /\(mapping\?\.writerAgentIds \?\? \[\]\)\.includes\(agentId\)/);
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => path.join(__dirname, '..') } } };
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => os.tmpdir());
  const script = path.join(__dirname, '..', 'resources', 'vault-mcp.cjs');
  const build = (write) => hive['buildDefaultMcpServers'](os.tmpdir(), {}, 'a1', { provider: 'claude' }, undefined, { root: '/v', scopes: ['01-Projects/Acme', '99-System'], script, ...(write ? { write } : {}) })['munder-vault'].env;
  assert.equal(build(null).VAULT_WRITER_AGENT, undefined);
  assert.equal(build(null).VAULT_LOCK_PATH, undefined);
  const env = build({ agentId: 'a1', lockPath: '/ud/vault-write.lock' });
  assert.deepEqual([env.VAULT_WRITER_AGENT, env.VAULT_LOCK_PATH], ['a1', '/ud/vault-write.lock']);
  assert.ok(MCP_CATALOG.find((e) => e.id === 'vault'));
});

test('a session: snapshot, writes, snapshot, release; the vault ends clean and the lock is outside it', () => {
  const f = fixture(); const a = f.mk('angela-1');
  assert.throws(() => call(a, 'vault_append', { path: '01-Projects/Acme/Log.md', text: 'x' }), /no active write session/);
  assert.match(begin(a), /snapshot taken/);
  assert.ok(fs.existsSync(f.lockPath) && !f.lockPath.startsWith(f.root + path.sep));
  assert.match(f.log()[0], /SB pre-update \(angela-1\): test/);
  call(a, 'vault_append', { path: '01-Projects/Acme/Log.md', text: '## 2026-10-05\n- did a thing' });
  call(a, 'vault_append', { path: '00-Inbox/Inbox.md', text: '- unsure which project' });
  call(a, 'vault_write', { path: '01-Projects/Acme/Task/T-2.md', content: 'new task' });
  assert.match(end(a), /post-update snapshot taken, lock released/);
  assert.ok(!fs.existsSync(f.lockPath));
  assert.match(f.log()[0], /SB post-update/);
  assert.equal(f.status(), '');                                    // nothing stray (no temp files, no lock)
  assert.equal(fs.readFileSync(path.join(f.root, '01-Projects/Acme/Log.md'), 'utf8'), '# Log\n## 2026-10-05\n- did a thing\n');
  assert.equal(fs.readFileSync(path.join(f.root, '00-Inbox/Inbox.md'), 'utf8'), '# Inbox\n- unsure which project\n');
  assert.equal(fs.readFileSync(path.join(f.root, '01-Projects/Acme/Task/T-2.md'), 'utf8'), 'new task');
  assert.throws(() => call(a, 'vault_append', { path: '01-Projects/Acme/Log.md', text: 'x' }), /no active write session/); // session over
});

test('scope: own project + append-only Inbox; everything else, traversal, hidden and links refused', () => {
  const f = fixture(); const a = f.mk('angela-1'); begin(a);
  fs.symlinkSync(path.join(f.root, '01-Projects/Other'), path.join(f.root, '01-Projects/Acme/otherlink'));
  fs.mkdirSync(path.join(f.root, '01-Projects/Acme/.obsidian'));
  fs.symlinkSync(path.join(f.root, '01-Projects/Acme/.obsidian'), path.join(f.root, '01-Projects/Acme/notes'));
  fs.symlinkSync(path.join(f.root, '01-Projects/Other/Log.md'), path.join(f.root, '01-Projects/Acme/linked.md'));
  const w = (p) => call(a, 'vault_write', { path: p, content: 'x' });
  const ap = (p) => call(a, 'vault_append', { path: p, text: 'x' });
  for (const p of ['01-Projects/Other/Log.md', '01-Projects/Other/New.md', '99-System/Protocol.md', '99-System/New.md', '03-Resources/New.md',
    '00-Inbox/Other.md', 'Root.md', '../escape.md', '01-Projects/Acme/../Other/New.md', '/etc/x.md', '01-Projects\\Other\\x.md',
    '01-Projects/Acme/.obsidian/x.md', '01-Projects/Acme/otherlink/New.md', '01-Projects/Acme/notes/New.md', '01-Projects/Acme/linked.md',
    '01-Projects/Acme/data.json', '01-Projects/Acme/nodir/New.md']) {
    assert.throws(() => w(p), /invalid|outside|not a regular|only \.md|no such|ENOENT/i, `write ${p}`);
    assert.throws(() => ap(p), /invalid|outside|not a regular|only \.md|no such|ENOENT|Inbox/i, `append ${p}`);
  }
  assert.throws(() => w('00-Inbox/Inbox.md'), /append-only/);                   // Inbox is never replaced
  assert.equal(fs.readFileSync(path.join(f.root, '01-Projects/Other/Log.md'), 'utf8'), 'other client');
  assert.match(ap('00-Inbox/Inbox.md'), /appended/);                              // but may be appended to
  end(a);
});

test('replacing a note needs the hash of what was read; a concurrent human edit is a conflict', () => {
  const f = fixture(); const a = f.mk('angela-1'); begin(a);
  const p = '01-Projects/Acme/Log.md';
  assert.throws(() => call(a, 'vault_write', { path: p, content: 'new' }), /pass base_hash/);
  const base = V.sha('# Log\n');
  fs.appendFileSync(path.join(f.root, p), 'human edit in Obsidian\n');            // the human wins the race
  assert.throws(() => call(a, 'vault_write', { path: p, content: 'new', base_hash: base }), /conflict/);
  assert.equal(fs.readFileSync(path.join(f.root, p), 'utf8'), '# Log\nhuman edit in Obsidian\n');
  const cur = V.sha('# Log\nhuman edit in Obsidian\n');
  call(a, 'vault_write', { path: p, content: '# Log\nhuman edit in Obsidian\nmerged\n', base_hash: cur });
  assert.throws(() => call(a, 'vault_write', { path: '01-Projects/Acme/New.md', content: 'x', base_hash: cur }), /does not exist/);
  assert.throws(() => call(a, 'vault_write', { path: '01-Projects/Acme/Big.md', content: 'x'.repeat(210 * 1024) }), /too large/);
  end(a);
});

test('lock contention: a second writer waits then is refused, and gets in once the first ends', () => {
  const f = fixture(); const a = f.mk('angela-1'), b = f.mk('angela-2');
  begin(a);
  const t = Date.now();
  assert.throws(() => begin(b), /being updated by angela-1/);
  assert.ok(Date.now() - t >= 350, 'it waited for the lock before giving up');
  assert.throws(() => call(b, 'vault_append', { path: '01-Projects/Acme/Log.md', text: 'x' }), /no active write session/);
  end(a);
  assert.match(begin(b), /started/);
  end(b);
});

test('stale locks are recovered: dead holder, or idle past the TTL; a live fresh one is not', () => {
  const f = fixture(); const b = f.mk('angela-2');
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(child.stdout);
  const lock = (info) => { fs.rmSync(f.lockPath, { recursive: true, force: true }); fs.mkdirSync(f.lockPath); fs.writeFileSync(path.join(f.lockPath, 'info.json'), JSON.stringify(info)); };
  lock({ pid: deadPid, agent: 'angela-1', ts: Date.now() });                       // holder crashed
  assert.match(begin(b), /started/); end(b);
  lock({ pid: process.pid, agent: 'angela-1', ts: Date.now() - V.LOCK_TTL_MS - 1000 }); // holder idle too long
  assert.match(begin(b), /started/); end(b);
  lock({ pid: process.pid, agent: 'angela-1', ts: Date.now() });                   // live and fresh: respected
  assert.throws(() => begin(b), /being updated by angela-1/);
  fs.rmSync(f.lockPath, { recursive: true, force: true }); fs.mkdirSync(f.lockPath);  // corrupt lock (no info): recovered
  assert.match(begin(b), /started/); end(b);
  assert.ok(!fs.readdirSync(f.base).some((n) => n.includes('.stale-')), 'no leftovers');
});

test('a lost lock stops writes: another writer took over after this session expired', () => {
  const f = fixture(); const a = f.mk('angela-1'), b = f.mk('angela-2');
  begin(a);
  fs.writeFileSync(path.join(f.lockPath, 'info.json'), JSON.stringify({ pid: process.pid, agent: 'angela-1', ts: 1 })); // went stale
  begin(b);                                                                                                           // b recovers it
  assert.throws(() => call(a, 'vault_append', { path: '01-Projects/Acme/Log.md', text: 'x' }), /expired/);
  end(b);
});

test('snapshot discipline: a failing or missing snapshot script refuses to write and frees the lock', () => {
  for (const mode of ['fail', 'missing']) {
    const f = fixture({ snapshot: mode }); const a = f.mk('angela-1');
    assert.throws(() => begin(a), mode === 'fail' ? /snapshot failed; refusing to write/ : /snapshot script is missing/);
    assert.ok(!fs.existsSync(f.lockPath), 'lock released');
    assert.throws(() => call(a, 'vault_append', { path: '01-Projects/Acme/Log.md', text: 'x' }), /no active write session/);
    assert.equal(fs.readFileSync(path.join(f.root, '01-Projects/Acme/Log.md'), 'utf8'), '# Log\n');
  }
});

test('a failing post-update snapshot is reported, and the lock is still released', () => {
  const f = fixture(); const a = f.mk('angela-1'); begin(a);
  call(a, 'vault_append', { path: '01-Projects/Acme/Log.md', text: 'x' });
  fs.writeFileSync(path.join(f.root, '99-System/scripts/sb-snapshot.sh'), '#!/usr/bin/env bash\nexit 1\n');
  assert.match(end(a), /post-update snapshot FAILED/);
  assert.ok(!fs.existsSync(f.lockPath));
});
