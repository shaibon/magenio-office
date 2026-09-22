/**
 * t-065 — a codex agent gets the same default `munder-*` MCP servers the Claude
 * path writes to its `mcp.json`, in the only surface codex reads them from:
 * `[mcp_servers.*]` tables inside the agent's own `CODEX_HOME/config.toml`.
 *
 * The generation is exercised through the real spawn helper
 * (`HiveManager.codexMcpTables`) so consent, enablement, per-project scoping and
 * the Magento fail-closed rule are the production ones, not a re-implementation.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-mcp-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { codexMcpServers, codexMcpToml } = loadTs('src/shared/codexMcp.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

/** Every catalog entry explicitly OFF — the only way to get an empty bundle, since
 *  an ABSENT consent entry takes the catalog default (safe-readonly = ON). */
const ALL_OFF = Object.fromEntries(MCP_CATALOG.map((e) => [e.id, { enabled: false }]));

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const hive = new HiveManager(() => userData);
// A repo-shaped cwd: `git` is scoped to the agent cwd, and t-067 mounts it only
// inside a git working tree, so the scoping assertion below needs a real one.
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-cwd-'));
fs.writeFileSync(path.join(CWD, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
test.after(() => fs.rmSync(CWD, { recursive: true, force: true }));

/** A fully installed user-configured server on disk, so the preflight passes. */
function installedServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-pkg-'));
  const entry = path.join(root, 'build', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// server');
  fs.writeFileSync(path.join(root, '.env'), 'TRELLO_API_KEY=k\nTRELLO_TOKEN=t\n');
  const command = path.join(root, 'bun');
  fs.writeFileSync(command, '#!/bin/sh\n');
  fs.chmodSync(command, 0o755);
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { command, args: [entry] };
}

/** The real generator, called the way the codex spawn branch calls it. */
function tables(cfg, agentId, meta = {}, magentoConfig) {
  return hive['codexMcpTables'](
    { id: agentId, cwd: CWD, provider: 'codex', ...meta },
    { mcpDefaults: cfg, magento: { config: magentoConfig } }
  );
}

// ─── the serializer (pure) ───────────────────────────────────────────────────

test('codexMcpToml renders [mcp_servers.*] tables with command, args and env', () => {
  const toml = codexMcpToml({
    'munder-time': { command: 'uvx', args: ['mcp-server-time'] },
    'munder-search': { command: 'npx', args: ['-y', 'pkg'], env: { BRAVE_API_KEY: '' } }
  });
  assert.match(toml, /\[mcp_servers\.munder-time\]/);
  assert.match(toml, /command = "uvx"/);
  assert.match(toml, /args = \["mcp-server-time"\]/);
  assert.match(toml, /\[mcp_servers\.munder-search\.env\]/);
  assert.match(toml, /BRAVE_API_KEY = ""/);
});

test('codexMcpToml is empty when there is nothing to add, so a plain worker is unchanged', () => {
  assert.equal(codexMcpToml({}), '');
});

test('codexMcpToml quotes a key that is not a bare TOML key', () => {
  const toml = codexMcpToml({ 'munder.a b': { command: 'x', args: [] } });
  assert.match(toml, /\[mcp_servers\."munder\.a b"\]/);
});

// ─── what a codex agent is actually given ────────────────────────────────────

test('an enabled default server reaches the codex config, scoped to the agent cwd', () => {
  const toml = tables({ time: { enabled: true }, filesystem: { enabled: true }, git: { enabled: true } }, 'jim-1');
  assert.match(toml, /\[mcp_servers\.munder-time\]/);
  assert.match(toml, /\[mcp_servers\.munder-filesystem\]/);
  assert.ok(toml.includes(`"${CWD}"`), 'filesystem/git are scoped to the agent cwd, never whole-disk');
  assert.match(toml, /\[mcp_servers\.munder-git\]/);
});

test('an explicitly disabled server is not written, and all-off writes nothing at all', () => {
  assert.equal(tables({ time: { enabled: false } }, 'jim-1').includes('munder-time'), false);
  assert.equal(tables(ALL_OFF, 'jim-1'), '');
});

test('an ABSENT consent entry falls back to the catalog default (safe-readonly = ON)', () => {
  // Same rule as the Claude path: `mcpDefaults` is a set of overrides, not a
  // closed list, so a config that has never mentioned `time` still gets it.
  const toml = tables({}, 'jim-1');
  assert.match(toml, /\[mcp_servers\.munder-time\]/);
  assert.equal(toml.includes('munder-trello'), false, 'shipped-OFF servers stay off');

});

test('magento stays fail-closed for codex: consent without a project binding gives no server', () => {
  const installed = installedServer();
  const cfg = { magento: { enabled: true, ...installed } };
  const toml = tables(cfg, 'jim-1', {}, undefined);
  assert.equal(toml.includes('munder-magento'), false);
});

test('magento reaches a codex agent with --config when its project binding exists', () => {
  const installed = installedServer();
  const cfg = { magento: { enabled: true, ...installed } };
  const toml = tables(cfg, 'jim-1', {}, '/tmp/project-burd.json');
  assert.match(toml, /\[mcp_servers\.munder-magento\]/);
  assert.ok(toml.includes('"--config"'), 'the project config is passed as its own argument');
  assert.ok(toml.includes('"/tmp/project-burd.json"'), 'and it is the agent\'s OWN project file');
});

test('the write tier is withheld from a non-god codex agent (no hook-side block exists there)', () => {
  const installed = installedServer();
  const cfg = { trello: { enabled: true, agents: [], ...installed } };
  assert.equal(tables(cfg, 'jim-1').includes('munder-trello'), false);
  assert.equal(tables(cfg, 'god', { isGod: true }).includes('munder-trello'), true);
});

test('the secret tier is NOT withheld by the codex filter (only the write tier is)', () => {
  // codexMcpServers drops the `write` tier for a non-god agent and nothing else:
  // Magento — a secret-tier, read-only, per-project server — still reaches codex
  // (the tests above assert that end to end). `search-with-key` is a SEPARATE case:
  // it is a secret-tier server whose key is still the catalog's empty placeholder,
  // so t-067's empty-env rule skips it for both providers while it stays unset.
  const kept = codexMcpServers(
    { 'munder-magento': { command: 'node', args: ['x.js'] }, 'munder-filesystem': { command: 'npx', args: [] } },
    { isGod: false }
  );
  assert.ok(kept['munder-magento'], 'a secret-tier server is not withheld');
  assert.ok(kept['munder-filesystem'], 'and neither is a safe-readonly one');

  const installed = installedServer();
  const toml = tables({ 'search-with-key': { enabled: true }, magento: { enabled: true, ...installed } }, 'jim-1', {}, '/tmp/p.json');
  assert.equal(toml.includes('munder-search-with-key'), false, 'empty key -> not mounted (t-067)');
  assert.match(toml, /\[mcp_servers\.munder-magento\]/, 'a configured secret-tier server still reaches codex');
});

test('codexMcpServers keeps the sandboxed servers and drops the write tier for a non-god agent', () => {
  const s = { 'munder-time': { command: 'uvx', args: ['t'] }, 'munder-trello': { command: 'bun', args: ['x'] } };
  assert.deepEqual(Object.keys(codexMcpServers(s, { isGod: false })), ['munder-time']);
  assert.deepEqual(Object.keys(codexMcpServers(s, { isGod: true })).sort(), ['munder-time', 'munder-trello']);
});

/** The servers withheld from a non-god codex agent because their tools put
 *  caller-supplied text on the wire to something the hive does not control. */
const EGRESS_SERVERS = ['fetch', 'context7'];

test('the unsandboxed egress servers are withheld from a non-god codex agent', () => {
  // t-070 review: with the tools pre-approved, a `fetch`/`context7` call is an
  // egress channel no human sees. codex has no PreToolUse allow-list, so the only
  // safe option on that provider is not to mount them.
  const s = {};
  for (const id of EGRESS_SERVERS) s[`munder-${id}`] = { command: 'uvx', args: [id] };
  s['munder-time'] = { command: 'uvx', args: ['t'] };
  assert.deepEqual(Object.keys(codexMcpServers(s, { isGod: false })), ['munder-time']);
  assert.deepEqual(Object.keys(codexMcpServers(s, { isGod: true })).sort(),
    ['munder-context7', 'munder-fetch', 'munder-time']);

  const cfg = { time: { enabled: true } };
  for (const id of EGRESS_SERVERS) cfg[id] = { enabled: true };
  const toml = tables(cfg, 'jim-1');
  for (const id of EGRESS_SERVERS) {
    assert.equal(toml.includes(`munder-${id}`), false, `a non-god codex agent never gets ${id}`);
    assert.match(tables({ [id]: { enabled: true } }, 'god', { isGod: true }), new RegExp(`\\[mcp_servers\\.munder-${id}\\]`));
  }
  assert.match(toml, /\[mcp_servers\.munder-time\]/, 'the other servers are unaffected');
});

test('the egress exclusion is codex-only: the Claude path still mounts them', () => {
  // The guard lives in codexMcpServers, not in the shared catalog builder — the
  // Claude path has the allow-list + permission prompts that make them usable.
  const cfg = { ...ALL_OFF };
  for (const id of EGRESS_SERVERS) cfg[id] = { enabled: true };
  const map = hive['buildDefaultMcpServers'](CWD, cfg, 'jim-claude', { role: 'dev', provider: 'claude' });
  for (const id of EGRESS_SERVERS) assert.ok(map[`munder-${id}`], `the Claude path is untouched by a codex-only guard (${id})`);
});

// ─── t-070: the tools must be CALLABLE, not just visible ─────────────────────

test('every managed server is mounted pre-approved: codex never waits for a human', () => {
  const toml = codexMcpToml({ 'munder-time': { command: 'uvx', args: ['mcp-server-time'] } });
  assert.match(toml, /default_tools_approval_mode = "approve"/);
});

test('the pre-approval lands in the SERVER table, before any env sub-table', () => {
  const toml = codexMcpToml({
    'munder-search': { command: 'npx', args: ['-y', 'pkg'], env: { BRAVE_API_KEY: 'k' } }
  });
  const mode = toml.indexOf('default_tools_approval_mode');
  const env = toml.indexOf('[mcp_servers.munder-search.env]');
  assert.ok(mode > 0, 'the mode is written');
  assert.ok(mode < env, 'a key after the env header would land in the env table');
});

test('the value is the one codex 0.155.1 accepts, and the only one that never prompts', () => {
  // Verified on the binary: a bogus value fails with
  // "unknown variant `zzz`, expected one of `auto`, `prompt`, `writes`, `approve`".
  const toml = codexMcpToml({ 'munder-magento': { command: 'node', args: ['x.js'] } });
  assert.match(toml, /default_tools_approval_mode = "approve"/);
  assert.equal(/default_tools_approval_mode = "(auto|prompt|writes)"/.test(toml), false);
});

test('the write tier keeps codex\'s own gating — no pre-approval on write tools', () => {
  const toml = codexMcpToml({ 'munder-trello': { command: 'bun', args: ['x'] } });
  assert.match(toml, /\[mcp_servers\.munder-trello\]/, 'the table itself is still rendered');
  assert.equal(toml.includes('default_tools_approval_mode'), false,
    'the codex path has no PreToolUse allow-list, so its own gating is the only control');
});

test('a real codex agent config carries the pre-approval end to end', () => {
  const toml = tables({ time: { enabled: true } }, 'jim-1');
  assert.match(toml, /\[mcp_servers\.munder-time\][\s\S]*default_tools_approval_mode = "approve"/);
});

// ─── the wiring (the spawn path really uses the generator) ───────────────────

test('the codex spawn branch installs the generated tables, and the Claude path is untouched', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(src, /installCodexHooks\(dir, meta\.id, this\.codexMcpTables\(meta, opts\)\)/,
    'the codex spawn passes the default-MCP tables into its CODEX_HOME config');
  assert.match(src, /private installCodexHooks\(dir: string, agentId: string, mcpTables = ''\)/);
  assert.match(src, /config \+= mcpTables;/, 'the installer appends them (never replaces the user seed)');
  assert.match(src, /--mcp-config/, 'the Claude path still ships its own mcp.json route');
});
