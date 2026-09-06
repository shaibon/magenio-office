'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

// jiraProjects.ts imports ./config at load time, which resolves its file
// through electron's app.getPath. The mock MUST be installed before the first
// load (loadTs caches by filename for the life of this file).
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trello-validate-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { validateJiraProjectBinding } = loadTs('src/main/jiraProjects.ts');
const { isRepo, getBranches } = loadTs('src/main/git.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trello-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  spawnSync('git', ['branch', 'develop'], { cwd: dir });
  return dir;
}

const deps = { isRepo, getBranches, agentExists: () => true };

function bindingWith(trello, repo) {
  return { key: 'BURD', repo, baseBranch: 'develop', enabled: true, ...(trello ? { trello } : {}) };
}

test('a binding with no trello source still validates exactly as before', async () => {
  const repo = initRepo();
  const result = await validateJiraProjectBinding(bindingWith(null, repo), [], deps);
  assert.deepEqual(result, { ok: true });
});

test('a well-formed trello source validates', async () => {
  const repo = initRepo();
  const trello = { boardShortLink: 'AbCd1234', boardLabel: 'My Board', intakeLists: ['Approvati'], enabled: true };
  const result = await validateJiraProjectBinding(bindingWith(trello, repo), [], deps);
  assert.deepEqual(result, { ok: true });
});

test('a malformed trello short link is rejected with a message', async () => {
  const repo = initRepo();
  const trello = { boardShortLink: 'nope', boardLabel: 'X', intakeLists: ['Approvati'], enabled: true };
  const result = await validateJiraProjectBinding(bindingWith(trello, repo), [], deps);
  assert.equal(result.ok, false);
  assert.ok(/short link/i.test(result.error));
});

test('a trello source with no intake list is rejected', async () => {
  const repo = initRepo();
  const trello = { boardShortLink: 'AbCd1234', boardLabel: 'X', intakeLists: [], enabled: true };
  const result = await validateJiraProjectBinding(bindingWith(trello, repo), [], deps);
  assert.equal(result.ok, false);
});
