'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  MCP_CATALOG,
  mcpCatalogEntry,
  isSafeReadonlyMcp,
  defaultMcpDefaults,
  seedMcpConsent,
  mergeMcpConsent,
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

test('defaultMcpDefaults seeds trello as disabled AND restricted to god', () => {
  // Spec decision 7: Trello access is restricted to an explicit set of agents,
  // today ['god']. The safe configuration must be the default, not something
  // the user has to remember to type — an absent/empty allow-list means EVERY
  // agent, and this server exposes create_board/archive_list/update_card_details
  // while only god's mission carries the never-write-to-Trello discipline.
  assert.deepEqual(defaultMcpDefaults().trello, { enabled: false, agents: ['god'] });
});

test('the trello entry declares its allow-list in the catalog, next to its tier', () => {
  assert.deepEqual(mcpCatalogEntry('trello').defaultAgents, ['god']);
});

test('no other catalog entry is narrowed — every existing server still reaches every agent', () => {
  const defaults = defaultMcpDefaults();
  for (const entry of MCP_CATALOG) {
    if (entry.id === 'trello') continue;
    assert.equal(entry.defaultAgents, undefined, `${entry.id} unexpectedly grew an allow-list`);
    assert.deepEqual(defaults[entry.id], { enabled: entry.defaultEnabled }, `${entry.id} default consent changed shape`);
  }
});

test('seedMcpConsent carries the catalog allow-list, and copies it', () => {
  const seed = seedMcpConsent('trello');
  assert.deepEqual(seed, { enabled: false, agents: ['god'] });
  seed.agents.push('worker-1');
  assert.deepEqual(mcpCatalogEntry('trello').defaultAgents, ['god'], 'the catalog entry must not be mutable through a seed');
  assert.deepEqual(seedMcpConsent('unknown-entry'), { enabled: false });
});

test('mergeMcpConsent seeds the allow-list when materializing a consent', () => {
  // The documented flow is install → tick enable. Whichever of those writes
  // lands first must already carry the allow-list.
  assert.deepEqual(mergeMcpConsent('trello', undefined, { enabled: true }), { enabled: true, agents: ['god'] });
  assert.deepEqual(
    mergeMcpConsent('trello', undefined, { command: '/bin/bun', args: ['/pkg/build/index.js'] }),
    { enabled: false, agents: ['god'], command: '/bin/bun', args: ['/pkg/build/index.js'] }
  );
});

test('mergeMcpConsent seeds the allow-list onto an existing entry that has none', () => {
  // A config written before the allow-list existed carries { enabled: false }
  // and no `agents` key at all: absent is "never chosen", so it takes the default.
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: false }, { enabled: true }),
    { enabled: true, agents: ['god'] }
  );
});

test('mergeMcpConsent never re-seeds an allow-list the user deliberately emptied', () => {
  // ABSENT ≠ EMPTY. Clearing the Agents field writes `agents: []` — a real
  // "every agent" choice. A later Install or toggle must leave it alone.
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: true, agents: [] }, { command: '/bin/bun' }),
    { enabled: true, agents: [], command: '/bin/bun' }
  );
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: false, agents: [] }, { enabled: true }),
    { enabled: true, agents: [] }
  );
  // …and an explicit patch to [] is honoured on the spot.
  assert.deepEqual(mergeMcpConsent('trello', undefined, { agents: [] }), { enabled: false, agents: [] });
});

test('mergeMcpConsent keeps a user-chosen allow-list and honours an explicit change', () => {
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: true, agents: ['god', 'pm'] }, { enabled: false }),
    { enabled: false, agents: ['god', 'pm'] }
  );
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: true, agents: ['god'] }, { agents: ['god', 'pm'] }),
    { enabled: true, agents: ['god', 'pm'] }
  );
});

test('mergeMcpConsent leaves entries without a catalog allow-list exactly as they were', () => {
  assert.deepEqual(mergeMcpConsent('git', undefined, { enabled: false }), { enabled: false });
  assert.deepEqual(
    mergeMcpConsent('github-token', { enabled: true }, { command: '/x' }),
    { enabled: true, command: '/x' }
  );
  assert.equal('agents' in mergeMcpConsent('git', undefined, {}), false, 'no phantom agents key');
});

test('mergeMcpConsent does not alias the caller\'s stored entry', () => {
  const existing = { enabled: false, agents: ['god'] };
  const merged = mergeMcpConsent('trello', existing, { enabled: true });
  assert.equal(existing.enabled, false, 'the stored entry must not be mutated in place');
  assert.notEqual(merged, existing);
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
