'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-scope-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { HiveManager } = loadTs('src/main/hive.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const hive = new HiveManager(() => userData);
const cwd = '/tmp/agent-cwd';

// `buildDefaultMcpServers` is private in TypeScript only — at run time it is a
// plain method, and calling it directly is far more precise than reconstructing
// a whole spawn just to read one block of the settings file.
function build(cfg, agentId, roleMeta) {
  return hive['buildDefaultMcpServers'](cwd, cfg, agentId, roleMeta);
}

const PM = { role: 'Project manager: routes tasks, tracks Jira, gates QA sign-off, reports to the Boss', capabilities: ['project-management'] };

/** A fully installed, credentialed Trello server on disk, so the preflight passes. */
function installedTrello() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-pkg-'));
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'build', 'index.js'), '// server');
  fs.writeFileSync(path.join(root, '.env'), 'TRELLO_API_KEY=k\nTRELLO_TOKEN=t\n');
  const command = path.join(root, 'bun');
  fs.writeFileSync(command, '#!/bin/sh\n');
  fs.chmodSync(command, 0o755);
  return { command, args: [path.join(root, 'build', 'index.js')] };
}

test('an unscoped consent still reaches every agent (regression)', () => {
  const cfg = { 'sequential-thinking': { enabled: true } };
  assert.ok(build(cfg, 'god')['munder-sequential-thinking']);
  assert.ok(build(cfg, 'worker-1')['munder-sequential-thinking']);
});

test('an agents-scoped consent reaches only the listed agents', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], command, args } };
  assert.ok(build(cfg, 'god')['munder-trello'], 'god should receive the scoped server');
  assert.equal(build(cfg, 'worker-1')['munder-trello'], undefined, 'a worker must not receive it');
});

test('an empty agents list means every agent, not none', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: [], command, args } };
  assert.ok(build(cfg, 'worker-1')['munder-trello']);
});

test('a userConfigured entry uses the consent command and args', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, command, args } };
  const server = build(cfg, 'god')['munder-trello'];
  assert.equal(server.command, command);
  assert.deepEqual(server.args, args);
});

test('a userConfigured entry with no command is omitted, not written broken', () => {
  const cfg = { trello: { enabled: true } };
  assert.equal(build(cfg, 'god')['munder-trello'], undefined);
});

test('a userConfigured entry that fails its preflight is omitted', () => {
  const { command } = installedTrello();
  const cfg = { trello: { enabled: true, command, args: ['/nowhere/build/index.js'] } };
  assert.equal(build(cfg, 'god')['munder-trello'], undefined);
});

test('a command override is ignored for an entry that is not userConfigured', () => {
  const cfg = { 'sequential-thinking': { enabled: true, command: '/bin/evil', args: ['x'] } };
  const server = build(cfg, 'god')['munder-sequential-thinking'];
  assert.equal(server.command, 'npx', 'a hand-edited config must not swap a catalog server binary');
});

// ─── t-056: role-based scoping (a PM gets Trello without being listed by id) ──

// NOTE: every test below sets a non-empty, non-matching `agents` list — an
// ABSENT/EMPTY `agents` list already means "every agent" (pre-existing
// behaviour, see the tests above), which would make the id path grant access
// regardless of role and silently pass these tests for the wrong reason.
// `agents: ['god']` mirrors the real seeded default (mcpCatalog.ts trello entry:
// `defaultAgents: ['god'], defaultRoles: ['pm']`).

test('a roles-scoped consent reaches a PM by role, not by id', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], roles: ['pm'], command, args } };
  assert.ok(build(cfg, 'pam-9999-a-brand-new-restore-id', PM)['munder-trello'], 'a PM must receive it regardless of its (post-restore) id');
});

test('a roles-scoped consent does not reach a non-PM agent', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], roles: ['pm'], command, args } };
  assert.equal(build(cfg, 'worker-1', { role: 'worker' })['munder-trello'], undefined);
});

test('a roles-scoped consent does not reach god even with matching role text', () => {
  const { command, args } = installedTrello();
  // `agents` deliberately does NOT include this agent's id, so only the role
  // path is exercised — isPmRole's own isGod guard must be what excludes it.
  const cfg = { trello: { enabled: true, agents: ['someone-else'], roles: ['pm'], command, args } };
  assert.equal(build(cfg, 'a-god-shaped-id', { ...PM, isGod: true })['munder-trello'], undefined);
});

test('agents and roles are additive — either match is enough', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], roles: ['pm'], command, args } };
  assert.ok(build(cfg, 'god')['munder-trello'], 'the id match still works');
  assert.ok(build(cfg, 'pam-1', PM)['munder-trello'], 'the role match also works');
  assert.equal(build(cfg, 'worker-1', { role: 'worker' })['munder-trello'], undefined);
});

test('a PM on a non-claude provider never receives the role-scoped server (permissions.deny only binds Claude Code)', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], roles: ['pm'], command, args } };
  assert.equal(build(cfg, 'pam-1', { ...PM, provider: 'opencode' })['munder-trello'], undefined);
  assert.equal(build(cfg, 'pam-1', { ...PM, provider: 'codex' })['munder-trello'], undefined);
  assert.ok(build(cfg, 'pam-1', { ...PM, provider: 'claude' })['munder-trello'], 'an explicit claude provider still works');
  assert.ok(build(cfg, 'pam-1', PM)['munder-trello'], 'an unset provider defaults to claude (today\'s only interactive-agent default)');
});

// ─── t-056: hookSettings blocks Trello write tools for every non-god agent ────

function hookSettingsFor(cfg, agentId, roleMeta) {
  return hive['hookSettings']('shim.cjs', agentId, cwd, cfg, undefined, [], roleMeta);
}

test('hookSettings denies the exact Trello write tools for a PM, and nothing else', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], roles: ['pm'], command, args } };
  const settings = hookSettingsFor(cfg, 'pam-1', PM);
  assert.ok(Array.isArray(settings.permissions.deny));
  assert.ok(settings.permissions.deny.includes('mcp__munder-trello__add_comment'));
  assert.ok(settings.permissions.deny.includes('mcp__munder-trello__update_card_details'));
  assert.ok(settings.permissions.deny.includes('mcp__munder-trello__perform_system_repair'));
  // Read tools must never be in the deny list.
  assert.ok(!settings.permissions.deny.includes('mcp__munder-trello__get_card'));
  assert.ok(!settings.permissions.deny.includes('mcp__munder-trello__get_lists'));
});

test('hookSettings does not deny anything for god even with Trello enabled', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], command, args } };
  const settings = hookSettingsFor(cfg, 'god', { isGod: true });
  assert.equal(settings.permissions, undefined);
});

test('hookSettings adds no permissions block at all when Trello is not enabled', () => {
  const cfg = { 'sequential-thinking': { enabled: true } };
  const settings = hookSettingsFor(cfg, 'pam-1', PM);
  assert.equal(settings.permissions, undefined);
});
