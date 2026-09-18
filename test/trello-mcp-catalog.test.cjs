'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  MCP_CATALOG,
  mcpCatalogEntry,
  isSafeReadonlyMcp,
  defaultMcpDefaults,
  seedMcpConsent,
  mergeMcpConsent,
  TRELLO_MCP_REPO_URL,
  TRELLO_MCP_TAG,
  TRELLO_READ_TOOLS,
  TRELLO_WRITE_TOOLS,
  TRELLO_KNOWN_TOOLS,
  trelloToolId,
  trelloDeniedToolIds,
  isTrelloTool,
  isTrelloReadOnlyCall
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

test('defaultMcpDefaults seeds trello as disabled AND restricted to god + the pm role', () => {
  // Spec decision 7: Trello access is restricted to an explicit set of agents,
  // today ['god']. The safe configuration must be the default, not something
  // the user has to remember to type — an absent/empty allow-list means EVERY
  // agent, and this server exposes create_board/archive_list/update_card_details
  // while only god's mission carries the never-write-to-Trello discipline.
  // t-056: `roles: ['pm']` is additive — a PM (Pam) reads it too, by role, with
  // its write tools hard-blocked (hookSettings' permissions.deny), not by id.
  assert.deepEqual(defaultMcpDefaults().trello, { enabled: false, agents: ['god'], roles: ['pm'] });
});

test('the trello entry declares its allow-list in the catalog, next to its tier', () => {
  assert.deepEqual(mcpCatalogEntry('trello').defaultAgents, ['god']);
  assert.deepEqual(mcpCatalogEntry('trello').defaultRoles, ['pm']);
});

test('no other catalog entry is narrowed — every existing server still reaches every agent', () => {
  const defaults = defaultMcpDefaults();
  for (const entry of MCP_CATALOG) {
    if (entry.id === 'trello') continue;
    assert.equal(entry.defaultAgents, undefined, `${entry.id} unexpectedly grew an allow-list`);
    assert.deepEqual(defaults[entry.id], { enabled: entry.defaultEnabled }, `${entry.id} default consent changed shape`);
  }
});

test('seedMcpConsent carries the catalog allow-list (by id and by role), and copies both', () => {
  const seed = seedMcpConsent('trello');
  assert.deepEqual(seed, { enabled: false, agents: ['god'], roles: ['pm'] });
  seed.agents.push('worker-1');
  seed.roles.push('everyone');
  assert.deepEqual(mcpCatalogEntry('trello').defaultAgents, ['god'], 'the catalog entry must not be mutable through a seed');
  assert.deepEqual(mcpCatalogEntry('trello').defaultRoles, ['pm'], 'the catalog entry must not be mutable through a seed');
  assert.deepEqual(seedMcpConsent('unknown-entry'), { enabled: false });
});

test('mergeMcpConsent seeds the allow-lists when materializing a consent', () => {
  // The documented flow is install → tick enable. Whichever of those writes
  // lands first must already carry the allow-lists.
  assert.deepEqual(mergeMcpConsent('trello', undefined, { enabled: true }), { enabled: true, agents: ['god'], roles: ['pm'] });
  assert.deepEqual(
    mergeMcpConsent('trello', undefined, { command: '/bin/bun', args: ['/pkg/build/index.js'] }),
    { enabled: false, agents: ['god'], roles: ['pm'], command: '/bin/bun', args: ['/pkg/build/index.js'] }
  );
});

test('mergeMcpConsent seeds the allow-lists onto an existing entry that has none', () => {
  // A config written before the allow-lists existed carries { enabled: false }
  // and no `agents`/`roles` key at all: absent is "never chosen", so each takes
  // its own catalog default independently.
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: false }, { enabled: true }),
    { enabled: true, agents: ['god'], roles: ['pm'] }
  );
});

test('mergeMcpConsent never re-seeds an allow-list the user deliberately emptied', () => {
  // ABSENT ≠ EMPTY. Clearing the Agents field writes `agents: []` — a real
  // "every agent" choice. A later Install or toggle must leave it alone.
  // `roles` is untouched in these existing entries, so it still seeds
  // independently — the two allow-lists are cleared one at a time, not as a pair.
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: true, agents: [] }, { command: '/bin/bun' }),
    { enabled: true, agents: [], roles: ['pm'], command: '/bin/bun' }
  );
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: false, agents: [] }, { enabled: true }),
    { enabled: true, agents: [], roles: ['pm'] }
  );
  // …and an explicit patch to [] is honoured on the spot, for either field.
  assert.deepEqual(mergeMcpConsent('trello', undefined, { agents: [] }), { enabled: false, agents: [], roles: ['pm'] });
  assert.deepEqual(mergeMcpConsent('trello', undefined, { roles: [] }), { enabled: false, agents: ['god'], roles: [] });
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: true, roles: [] }, { command: '/bin/bun' }),
    { enabled: true, agents: ['god'], roles: [], command: '/bin/bun' }
  );
});

test('mergeMcpConsent keeps a user-chosen allow-list and honours an explicit change', () => {
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: true, agents: ['god', 'pm'] }, { enabled: false }),
    { enabled: false, agents: ['god', 'pm'], roles: ['pm'] }
  );
  assert.deepEqual(
    mergeMcpConsent('trello', { enabled: true, agents: ['god'] }, { agents: ['god', 'pm'] }),
    { enabled: true, agents: ['god', 'pm'], roles: ['pm'] }
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

// ─── t-056 review fix: the tool classification is fail-closed ─────────────────

/** The BUILT Trello MCP server on this machine, if it is installed — the same
 *  bundle the app launches (`bun <install>/build/index.js`). Declared in the
 *  catalog comment and in the app's install path (<userData>/mcp/trello). */
function installedTrelloBuild() {
  const candidates = [
    process.env.MD_TRELLO_MCP_BUILD,
    path.join(os.homedir(), 'HarnessAgents', 'hive', 'agents', 'god', 'mcp', 'trello', 'build', 'index.js'),
    '/Users/shaibon/www/magenio-mcp/trello-mcp/build/index.js'
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

test('every tool of the pinned build is classified exactly once (read XOR write)', () => {
  const read = new Set(TRELLO_READ_TOOLS);
  const write = new Set(TRELLO_WRITE_TOOLS);
  for (const tool of read) {
    assert.equal(write.has(tool), false, `${tool} is classified both read and write`);
  }
  assert.equal(new Set(TRELLO_KNOWN_TOOLS).size, TRELLO_KNOWN_TOOLS.length, 'duplicate name in the known set');
  assert.deepEqual([...TRELLO_KNOWN_TOOLS].sort(), [...read, ...write].sort(), 'the known set is not read ∪ write');
});

test('the settings deny list covers every known write and nothing else', () => {
  const denied = trelloDeniedToolIds();
  assert.deepEqual([...denied].sort(), TRELLO_WRITE_TOOLS.map(trelloToolId).sort());
  for (const tool of TRELLO_READ_TOOLS) {
    assert.equal(denied.includes(trelloToolId(tool)), false, `a read tool must never be denied: ${tool}`);
  }
});

test('the runtime policy is an ALLOW-list: an unrecognised Trello tool is denied', () => {
  // Read tools: allowed, bare name or namespaced id alike.
  assert.equal(isTrelloReadOnlyCall('get_card'), true);
  assert.equal(isTrelloReadOnlyCall(trelloToolId('get_card')), true);
  assert.equal(isTrelloReadOnlyCall('search_cards'), true);
  // Known writes: denied.
  for (const tool of TRELLO_WRITE_TOOLS) {
    assert.equal(isTrelloReadOnlyCall(tool), false, tool);
    assert.equal(isTrelloReadOnlyCall(trelloToolId(tool)), false, tool);
  }
  // The fail-closed half: a tool this catalog has never heard of — a write added
  // by a newer server build — is denied, not waved through. The settings-level
  // deny list could not do this, which is why the PreToolUse hook is the guard.
  assert.equal(isTrelloReadOnlyCall('create_widget'), false);
  assert.equal(isTrelloReadOnlyCall(trelloToolId('create_widget')), false);
  assert.equal(isTrelloReadOnlyCall(''), false);
  assert.equal(isTrelloReadOnlyCall(undefined), false);
  // And the policy only claims Trello tools in the first place.
  assert.equal(isTrelloTool(trelloToolId('anything_at_all')), true);
  assert.equal(isTrelloTool('get_card'), true);
  assert.equal(isTrelloTool('mcp__other-server__get_card'), false);
  assert.equal(isTrelloTool('Bash'), false);
});

test('the pinned server build exposes nothing unclassified', { skip: !installedTrelloBuild() }, () => {
  // The completeness guard: it reads the BUILT server on this machine and fails
  // if it registers a tool the catalog does not classify, so a server bump that
  // adds a tool cannot ship silently — whoever raises TRELLO_MCP_TAG must
  // classify what the new build exposes. Skipped where the build is absent (CI).
  const source = fs.readFileSync(installedTrelloBuild(), 'utf8');
  const known = new Set(TRELLO_KNOWN_TOOLS);
  const exposed = new Set([...source.matchAll(/registerTool\(\s*["']([a-zA-Z0-9_]+)["']/g)].map((m) => m[1]));
  assert.ok(exposed.size > 0, 'no tool registrations found — the build layout changed, so this guard is blind');
  const unclassified = [...exposed].filter((t) => !known.has(t)).sort();
  assert.deepEqual(unclassified, [], `unclassified Trello tool(s): ${unclassified.join(', ')}`);
});
