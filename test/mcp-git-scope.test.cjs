/**
 * t-067, point 2 — `munder-git` is mounted only when the agent's cwd is inside a
 * git working tree.
 *
 * The `git` catalog entry is scoped to the agent's own cwd (`--repository <cwd>`),
 * so when that cwd is not a repo the server exits at startup with "not a valid Git
 * repository". The client then shows a server that never connects, which reads as
 * a client bug rather than a missing repo. god's cwd is the hive ROOT — not a
 * repo — so his git server was dead on every spawn while looking configured.
 *
 * Applies to Claude and codex alike: both read this same map.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-git-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { isInsideGitRepo } = loadTs('src/main/fs.ts');
const { codexMcpServers } = loadTs('src/shared/codexMcp.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const hive = new HiveManager(() => userData);

// A real checkout-shaped tree: a repo root holding a `.git` FILE, exactly like the
// linked worktrees every isolated agent runs in, plus a nested cwd inside it.
const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-repo-'));
fs.writeFileSync(path.join(repoRoot, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
const repoCwd = path.join(repoRoot, 'src', 'deep');
fs.mkdirSync(repoCwd, { recursive: true });
const plainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-plain-'));
test.after(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(plainCwd, { recursive: true, force: true });
});

function servers(cwd, cfg, agentId = 'jim-1', meta = {}) {
  return hive['buildDefaultMcpServers'](cwd, cfg, agentId, { provider: 'claude', ...meta });
}

const ON = { git: { enabled: true } };

test('isInsideGitRepo walks UP to the repo root and stops at the filesystem root', () => {
  const seen = [];
  const found = isInsideGitRepo('/a/b/c', (d) => { seen.push(d); return d === '/a'; });
  assert.equal(found, true);
  assert.deepEqual(seen, ['/a/b/c', '/a/b', '/a'], 'stops at the first ancestor that answers yes');

  const miss = [];
  const none = isInsideGitRepo('/a/b', (d) => { miss.push(d); return false; });
  assert.equal(none, false);
  assert.equal(miss[miss.length - 1], '/', 'terminates at the filesystem root, never loops');
});

test('isInsideGitRepo accepts a .git FILE, which is what a linked worktree has', () => {
  assert.equal(isInsideGitRepo(repoCwd), true);
  assert.equal(isInsideGitRepo(repoRoot), true);
});

test('isInsideGitRepo is false for a directory that is outside every repository', () => {
  assert.equal(isInsideGitRepo(plainCwd), false);
});

test('munder-git is mounted when the agent cwd is inside a git repo', () => {
  assert.ok(servers(repoCwd, ON)['munder-git'], 'a worktree cwd still gets its scoped git server');
});

test('munder-git is NOT mounted for a cwd outside every repo (god / the hive root)', () => {
  assert.equal(servers(plainCwd, ON)['munder-git'], undefined);
});

test('the git guard reaches codex too, through the same source map', () => {
  assert.ok(codexMcpServers(servers(repoCwd, ON))['munder-git']);
  assert.equal(codexMcpServers(servers(plainCwd, ON))['munder-git'], undefined);
});

test('the git guard does not touch any other safe-readonly server', () => {
  const s = servers(plainCwd, { time: { enabled: true }, filesystem: { enabled: true }, git: { enabled: true } });
  assert.ok(s['munder-time']);
  assert.ok(s['munder-filesystem']);
  assert.equal(s['munder-git'], undefined);
});
