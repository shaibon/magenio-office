/**
 * t-073 — reaping the MCP servers an agent session leaves behind.
 *
 * The reaper deliberately CANNOT be tested through its kill path (that would
 * SIGKILL real processes), so these tests drive the pure decision — the same
 * split as palaceReap.ts. The kill itself is one `hardKillTree` per decided pid,
 * already covered by procKill's own suite.
 *
 * The rules are asserted as a CRITERION plus a named list, not as special cases:
 * a table of realistic rows goes in, the exact set of pids that may be killed
 * comes out. Every clause of the filter has a row that fails alone if that clause
 * is dropped, because the failure mode here is not "we miss a leak" — it is
 * "we kill something of the Boss's".
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  declaredServerLines,
  parsePsRows,
  argvTokens,
  matchesDeclared,
  reapTargets,
  reapHiveMcp
} = loadTs('src/main/mcpReap.ts');

// ---------------------------------------------------------------- fixtures ---

/** A hive root whose agents declare the servers the app really writes out. */
function hiveRootWith(agents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcpreap-'));
  for (const [id, servers] of Object.entries(agents)) {
    const dir = path.join(root, 'agents', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers }));
  }
  return root;
}

const TRELLO = { command: '/opt/homebrew/bin/bun', args: ['/Users/x/www/magenio-mcp/trello-mcp/build/index.js'] };
const MAGENTO = {
  command: '/opt/homebrew/bin/node',
  args: ['/Users/x/www/magenio-mcp/magento-mcp/dist/index.js', '--config', '/Users/x/.config/magenio/burd.json']
};
// Declared with a CIDR-ish path that ALSO appears in an unrelated process's argv
// (codegraph, below). Exact token matching is what keeps them apart.
const FILESYSTEM = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/x/www/magenio-M2-ristosubito']
};
// Declared on a wrapper: its process-table argv[0] is not `uvx`, so it fails open.
const GIT = { command: 'uvx', args: ['mcp-server-git', '--repository', '/Users/x/HarnessAgents/worktrees/anda'] };

const ROOT = hiveRootWith({
  god: { 'munder-trello': TRELLO },
  pam: { 'munder-magento': MAGENTO, 'munder-filesystem': FILESYSTEM, 'munder-git': GIT }
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const DECLARED = declaredServerLines(ROOT);

const SELF = 93737;      // the Electron main process (never a candidate)
const SESSION = 97700;   // the codex session currently being torn down
const OTHER_SESSION = 88001; // a live sibling agent

/** One row of the process table: `[pid, ppid, pgid, command]`. */
const row = ([pid, ppid, pgid, command]) => ({ pid, ppid, pgid, command });
const table = (...rows) => rows.map(row);

/** The floor as measured on 2026-09-23, plus the traps. */
const FLOOR = table(
  // --- ours, leaked (detached + orphaned) : the only legitimate targets ---
  [7878, 1, 7878, `/opt/homebrew/bin/bun ${TRELLO.args[0]}`],
  [19218, 1, 19218, `/opt/homebrew/bin/node ${MAGENTO.args.join(' ')}`],
  // --- ours, still the child of the session being torn down (detached) ---
  [832, SESSION, 832, `/opt/homebrew/bin/node ${MAGENTO.args.join(' ')}`],
  // --- ours, but ALIVE: still parented to a live sibling session ---
  [2914, OTHER_SESSION, 2914, `/opt/homebrew/bin/node ${MAGENTO.args.join(' ')}`],
  // --- ours by argv, but NOT detached: the session's own group sweep owns it ---
  [4242, 1, 97700, `/opt/homebrew/bin/bun ${TRELLO.args[0]}`],
  // --- declared servers whose process argv[0] never equals the declared command ---
  [5555, 1, 5555, `node /Users/x/.npm/_npx/abc/node_modules/.bin/mcp-server-git --repository /Users/x/HarnessAgents/worktrees/anda`],
  // --- NOT ours: the Boss's own detached daemons (must never be touched) ---
  [8926, 1, 8926, `codegraph serve --mcp --path ${FILESYSTEM.args[3]}`],
  [2543, 1, 2543, '/Users/x/.hermes/node/bin/node /Users/x/.npm-magenio/lib/node_modules/openclaw/dist/index.js gateway --port 18789'],
  [86982, 1, 86982, 'codegraph serve --mcp --path /Users/x/www/magenio-farmadati-platform'],
  // --- NOT ours: an agent's own command that merely MENTIONS one of our paths ---
  [6001, SESSION, 6001, `grep -F ${TRELLO.args[0]}`],
  [6002, SESSION, 6002, `tail -f ${TRELLO.args[0]}.log`],
  [6003, 1, 6003, `node ${TRELLO.args[0]}.bak`],
  // --- the app itself ---
  [SELF, 1, 93713, '/Users/x/www/munder-difflin/node_modules/electron/dist/Electron .']
);

// ------------------------------------------------------------------ tests ---

test('declaredServerLines reads the app-authored mcp.json, deduped', () => {
  const keys = DECLARED.map((d) => [d.command, ...d.args].join(' '));
  assert.ok(keys.includes(`/opt/homebrew/bin/bun ${TRELLO.args[0]}`), 'trello declared');
  assert.ok(keys.includes(`/opt/homebrew/bin/node ${MAGENTO.args.join(' ')}`), 'magento declared');
  // Two agents may declare the same server; matching must not compare 13x.
  assert.equal(new Set(keys).size, keys.length, 'no duplicate declared lines');
  assert.equal(DECLARED.length, 4);
});

test('declaredServerLines ignores a malformed or hand-edited file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcpreap-bad-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'agents', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'broken', 'mcp.json'), '{ not json');
  // A server entry with no usable command declares nothing.
  fs.mkdirSync(path.join(root, 'agents', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'empty', 'mcp.json'), JSON.stringify({ mcpServers: { x: { args: ['/a'] } } }));
  assert.deepEqual(declaredServerLines(root), []);
  // No agents dir at all (a fresh install) is not an error either.
  assert.deepEqual(declaredServerLines(path.join(root, 'nope')), []);
});

test('parsePsRows keeps numeric rows and drops unparseable ones', () => {
  const rows = parsePsRows(
    '  832 97700   832 /opt/homebrew/bin/node /x/y.js --config /z.json\n' +
    '\n' +
    'garbage line without numbers\n'
  );
  assert.deepEqual(rows, [{
    pid: 832, ppid: 97700, pgid: 832, command: '/opt/homebrew/bin/node /x/y.js --config /z.json'
  }]);
});

test('matching is exact token-from-the-start, never substring', () => {
  const declared = [TRELLO];
  assert.ok(matchesDeclared(argvTokens(`/opt/homebrew/bin/bun ${TRELLO.args[0]}`), declared));
  // A prefix match on extra args is the same server (codex passes no extras, but
  // the rule must not be brittle to one).
  assert.ok(matchesDeclared(argvTokens(`/opt/homebrew/bin/bun ${TRELLO.args[0]} --extra`), declared));
  // The command token anchors it — a tool that only MENTIONS the path is not ours.
  assert.ok(!matchesDeclared(argvTokens(`grep -F ${TRELLO.args[0]}`), declared));
  assert.ok(!matchesDeclared(argvTokens(`bash -c "bun ${TRELLO.args[0]}"`), declared));
  assert.ok(!matchesDeclared(argvTokens(`bun ${TRELLO.args[0]}.bak`), declared));
  assert.ok(!matchesDeclared(argvTokens(`node ${TRELLO.args[0]}`), declared), 'different interpreter');
  assert.ok(!matchesDeclared([], declared));
  assert.ok(!matchesDeclared(argvTokens('/opt/homebrew/bin/bun'), declared), 'too short');
});

test('the declared directory of a filesystem server does not make codegraph ours', () => {
  // codegraph's `--path` is a directory this floor ALSO declares as a filesystem
  // server root. Identity must come from the command line, not from a path
  // appearing in argv — otherwise reaping the Boss's own tooling is one match away.
  const codegraph = argvTokens(`codegraph serve --mcp --path ${FILESYSTEM.args[3]}`);
  assert.ok(!matchesDeclared(codegraph, DECLARED));
});

test('app-start sweep: only our leaked, detached, ownerless servers are reaped', () => {
  assert.deepEqual(reapTargets(FLOOR, DECLARED, { selfPid: SELF }), [
    7878,   // bun trello-mcp  — orphan, detached, declared
    19218   // node magento-mcp — orphan, detached, declared
  ]);
});

test('THE BROADENING GUARD: the exact reap set cannot grow without failing here', () => {
  // One assertion over the whole realistic floor. Drop `pgid === pid`, drop the
  // `ppid === 1` ownership test, or match argv by substring instead of by token,
  // and this list changes. That is the point: a false positive is a process of
  // the Boss's, so the filter is pinned to a value, not to a shape.
  const got = reapTargets(FLOOR, DECLARED, { selfPid: SELF });
  assert.deepEqual(got, [7878, 19218]);
  const never = [8926, 2543, 86982, 6001, 6002, 6003, 2914, 4242, 5555, SELF];
  for (const pid of never) assert.ok(!got.includes(pid), `pid ${pid} must never be reaped`);
});

test('teardown reap: the dying session\'s own detached servers, and nobody else\'s', () => {
  // sessionPid = the codex session 97700: its own detached magento child (832) is
  // collected, the sibling agent's live server (2914) is not.
  const got = reapTargets(FLOOR, DECLARED, { sessionPid: SESSION, selfPid: SELF });
  assert.deepEqual(got, [7878, 19218, 832]);
  assert.ok(!got.includes(2914), 'a live sibling session keeps its server');
  assert.ok(!got.includes(OTHER_SESSION));
  // The session itself is never a target even if it happened to match.
  const selfMatched = table([SESSION, 1, SESSION, `/opt/homebrew/bin/bun ${TRELLO.args[0]}`]);
  assert.deepEqual(reapTargets(selfMatched, [TRELLO], { sessionPid: SESSION, selfPid: SELF }), []);
});

test('nothing is reaped when nothing is declared (fail closed on an empty catalog)', () => {
  assert.deepEqual(reapTargets(FLOOR, [], { selfPid: SELF }), []);
  assert.deepEqual(reapTargets(FLOOR, [], { sessionPid: SESSION, selfPid: SELF }), []);
});

test('an attached server is left to the process-group sweep that already covers it', () => {
  // pgid == the session's pid: it never escaped, so ensureKilled's group kill
  // reaches it. Reaping it here would be redundant, and the pgid clause is what
  // keeps a row like this out of the target list.
  const attached = table([7001, 1, 97700, `/opt/homebrew/bin/bun ${TRELLO.args[0]}`]);
  assert.deepEqual(reapTargets(attached, [TRELLO], { selfPid: SELF }), []);
});

test('reapHiveMcp is a no-op with no declarations on disk', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcpreap-empty-'));
  test.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  // Returns before touching `ps` or any pid: an empty hive can kill nothing.
  assert.deepEqual(reapHiveMcp(empty), { reaped: [], unreadable: false });
  assert.deepEqual(reapHiveMcp(empty, { sessionPid: SESSION }), { reaped: [], unreadable: false });
});
