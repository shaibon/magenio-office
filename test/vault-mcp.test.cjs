'use strict';

// munder-vault: scoping, traversal/symlink escape, fail-closed, search, stdio.
// The vault is a temp-dir fixture; nothing here touches a real vault.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const V = require('../resources/vault-mcp.cjs');
const { vaultScopesFor } = loadTs('src/shared/vaultMount.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fx-'));
  const root = path.join(base, 'vault');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('01-Projects/Acme/Stato.md', '# Stato\nSprint 12 checkout refactor in progress');
  put('01-Projects/Acme/Task/ACME-1.md', 'Fixed the checkout bug');
  put('01-Projects/Acme/.obsidian/workspace.md', 'checkout secret-config');
  put('01-Projects/Other/Stato.md', 'Other client: checkout NDA material');
  put('99-System/Protocol.md', 'Shared protocol: checkout etiquette');
  put('03-Resources/Glossary.md', 'glossary');
  put('00-Inbox/private.md', 'personal checkout diary');
  fs.writeFileSync(path.join(base, 'outside.md'), 'outside the vault checkout');
  fs.symlinkSync(path.join(base, 'outside.md'), path.join(root, '01-Projects/Acme/escape.md'));
  fs.symlinkSync(path.join(root, '01-Projects/Other'), path.join(root, '01-Projects/Acme/otherlink'));
  const ctx = V.loadScopes(root, JSON.stringify(['01-Projects/Acme', '99-System', '03-Resources']));
  return { base, root, ctx };
}
const call = (ctx, name, args) => V.callTool(ctx, name, args);

test('list: no path shows only the readable folders', () => {
  const { ctx } = fixture();
  const out = call(ctx, 'vault_list', {});
  assert.match(out, /01-Projects\/Acme/);
  assert.match(out, /99-System/);
  assert.doesNotMatch(out, /Other|00-Inbox/);
});

test('list: project folder hides dotdirs and symlinks that leave scope', () => {
  const { ctx } = fixture();
  const out = call(ctx, 'vault_list', { path: '01-Projects/Acme' });
  assert.match(out, /Stato\.md/);
  assert.match(out, /Task\//);
  assert.doesNotMatch(out, /obsidian|escape|otherlink/);
});

test('read: project note and shared areas work', () => {
  const { ctx } = fixture();
  assert.match(call(ctx, 'vault_read', { path: '01-Projects/Acme/Stato.md' }), /Sprint 12/);
  assert.match(call(ctx, 'vault_read', { path: '99-System/Protocol.md' }), /Shared protocol/);
  assert.match(call(ctx, 'vault_read', { path: '03-Resources/Glossary.md' }), /glossary/);
});

test('read: other projects, other vault areas, traversal and absolute paths are refused', () => {
  const { ctx, root, base } = fixture();
  for (const p of [
    '01-Projects/Other/Stato.md', '00-Inbox/private.md',
    '01-Projects/Acme/../Other/Stato.md', '../outside.md', '../../etc/passwd',
    path.join(root, '01-Projects/Other/Stato.md'), path.join(base, 'outside.md'),
    '01-Projects/Acme/.obsidian/workspace.md', '', '01-Projects\\Other\\Stato.md', 'a\0b'
  ]) assert.throws(() => call(ctx, 'vault_read', { path: p }), /invalid|outside|not found/, p);
});

test('read: symlinks escaping the scope are refused', () => {
  const { ctx } = fixture();
  assert.throws(() => call(ctx, 'vault_read', { path: '01-Projects/Acme/escape.md' }), /outside/);
  assert.throws(() => call(ctx, 'vault_read', { path: '01-Projects/Acme/otherlink/Stato.md' }), /outside/);
});

test('a visible symlink into a hidden dir exposes nothing (read, list, search)', () => {
  const { ctx, root } = fixture();
  fs.writeFileSync(path.join(root, '01-Projects/Acme/.obsidian/private.md'), 'plugin-secret');
  fs.symlinkSync(path.join(root, '01-Projects/Acme/.obsidian'), path.join(root, '01-Projects/Acme/notes'));
  assert.throws(() => call(ctx, 'vault_read', { path: '01-Projects/Acme/notes/private.md' }), /outside/);
  assert.throws(() => call(ctx, 'vault_list', { path: '01-Projects/Acme/notes' }), /outside/);
  assert.doesNotMatch(call(ctx, 'vault_list', { path: '01-Projects/Acme' }), /notes/);
  assert.doesNotMatch(call(ctx, 'vault_search', { query: 'plugin-secret' }), /private|notes/);
  assert.equal(call(ctx, 'vault_search', { query: 'plugin-secret' }), 'no matches');
});

test('read: only .md, and large notes are truncated', () => {
  const { ctx, root } = fixture();
  fs.writeFileSync(path.join(root, '99-System/data.json'), '{}');
  assert.throws(() => call(ctx, 'vault_read', { path: '99-System/data.json' }), /only \.md/);
  fs.writeFileSync(path.join(root, '99-System/big.md'), 'x'.repeat(V.MAX_READ_BYTES + 500));
  const out = call(ctx, 'vault_read', { path: '99-System/big.md' });
  assert.match(out, /truncated/);
  assert.ok(out.length < V.MAX_READ_BYTES + 200);
});

test('search: finds in scope, never leaks other projects, dotdirs, symlinked or outside files', () => {
  const { ctx } = fixture();
  const out = call(ctx, 'vault_search', { query: 'checkout' });
  assert.match(out, /01-Projects\/Acme\/Stato\.md/);
  assert.match(out, /01-Projects\/Acme\/Task\/ACME-1\.md/);
  assert.match(out, /99-System\/Protocol\.md/);
  assert.doesNotMatch(out, /Other|00-Inbox|obsidian|escape|outside/);
});

test('search: all words must match, limit applies, empty query rejected', () => {
  const { ctx } = fixture();
  assert.match(call(ctx, 'vault_search', { query: 'checkout refactor' }), /Stato\.md/);
  assert.equal(call(ctx, 'vault_search', { query: 'checkout nonexistentword' }), 'no matches');
  assert.equal(call(ctx, 'vault_search', { query: 'checkout', limit: 1 }).split('\n\n').length, 1);
  assert.throws(() => call(ctx, 'vault_search', { query: '  ' }), /empty/);
});

test('fail-closed: no scopes, bad scopes, missing root', () => {
  const { root } = fixture();
  for (const [r, s] of [[root, '[]'], [root, 'nope'], [undefined, '["99-System"]'], [path.join(root, 'missing'), '["99-System"]'],
    [root, JSON.stringify(['..', '/etc', '.git', '99-System/../01-Projects/Other'])]]) {
    const ctx = V.loadScopes(r, s);
    assert.throws(() => call(ctx, 'vault_list', {}), /no vault folders/);
    assert.throws(() => call(ctx, 'vault_read', { path: '99-System/Protocol.md' }), /no vault folders/);
  }
});

test('a scope that is a symlink out of the vault is dropped', () => {
  const { root, base } = fixture();
  fs.symlinkSync(base, path.join(root, 'linked-out'));
  assert.deepEqual(V.loadScopes(root, JSON.stringify(['linked-out'])).scopes, []);
});

test('vaultScopesFor: plain relative folders only, shared areas appended', () => {
  assert.deepEqual(vaultScopesFor('01-Projects/BurdaStyle'), ['01-Projects/BurdaStyle', '99-System', '03-Resources']);
  assert.deepEqual(vaultScopesFor('01-Projects/X/'), ['01-Projects/X', '99-System', '03-Resources']);
  for (const bad of ['', undefined, null, '/abs', '../x', 'a/../b', '.obsidian', 'a/.git', 'a\\b', '//']) assert.equal(vaultScopesFor(bad), null, String(bad));
});

test('catalog: vault is a shipped-on safe-readonly entry', () => {
  const e = MCP_CATALOG.find((x) => x.id === 'vault');
  assert.equal(e.tier, 'safe-readonly');
  assert.equal(e.defaultEnabled, true);
});

test('stdio: initialize, tools/list (read tools only), tools/call', async () => {
  const { root } = fixture();
  const child = spawn(process.execPath, [path.join(__dirname, '../resources/vault-mcp.cjs')], {
    env: { ...process.env, VAULT_ROOT: root, VAULT_SCOPES: JSON.stringify(['01-Projects/Acme']) }
  });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vault_read', arguments: { path: '01-Projects/Other/Stato.md' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vault_read', arguments: { path: '01-Projects/Acme/Stato.md' } } });
  const deadline = Date.now() + 5000;
  while (lines.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  child.kill();
  const by = Object.fromEntries(lines.map((l) => [l.id, l.result]));
  assert.equal(by[1].serverInfo.name, 'munder-vault');
  assert.deepEqual(by[2].tools.map((t) => t.name), ['vault_list', 'vault_read', 'vault_search']);
  assert.equal(by[3].isError, true);
  assert.match(by[4].content[0].text, /Sprint 12/);
});
