'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  MCP_CATALOG,
  mcpCatalogEntry,
  isSafeReadonlyMcp,
  defaultMcpDefaults,
  TRELLO_MCP_REPO_URL,
  TRELLO_MCP_TAG
} = loadTs('src/shared/mcpCatalog.ts');

test('the trello entry exists, is user-configured and ships off', () => {
  const entry = mcpCatalogEntry('trello');
  assert.ok(entry, 'no trello entry in MCP_CATALOG');
  assert.equal(entry.userConfigured, true);
  assert.equal(entry.tier, 'write');
  assert.equal(entry.defaultEnabled, false);
  assert.equal(entry.spec.command, '', 'the command is supplied by the user, not the catalog');
});

test('trello is not a safe-readonly server', () => {
  assert.equal(isSafeReadonlyMcp('trello'), false);
});

test('defaultMcpDefaults seeds trello as disabled', () => {
  assert.deepEqual(defaultMcpDefaults().trello, { enabled: false });
});

test('the installer source is pinned to a tag, never a branch', () => {
  assert.equal(TRELLO_MCP_REPO_URL, 'https://github.com/delorenj/mcp-server-trello.git');
  assert.match(TRELLO_MCP_TAG, /^v\d+\.\d+\.\d+$/);
});

test('every other catalog entry keeps a non-empty command', () => {
  for (const entry of MCP_CATALOG) {
    if (entry.userConfigured) continue;
    assert.ok(entry.spec.command.length > 0, `${entry.id} lost its command`);
  }
});
