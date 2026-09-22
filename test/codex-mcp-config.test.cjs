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
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-cwd-'));
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

test('the secret tier is NOT withheld: a read-only keyed server still reaches codex', () => {
  const toml = tables({ 'search-with-key': { enabled: true } }, 'jim-1');
  assert.match(toml, /\[mcp_servers\.munder-search-with-key\]/);
});

test('codexMcpServers keeps every safe-readonly server and drops only the write tier', () => {
  const s = { 'munder-time': { command: 'uvx', args: ['t'] }, 'munder-trello': { command: 'bun', args: ['x'] } };
  assert.deepEqual(Object.keys(codexMcpServers(s, { isGod: false })), ['munder-time']);
  assert.deepEqual(Object.keys(codexMcpServers(s, { isGod: true })).sort(), ['munder-time', 'munder-trello']);
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
