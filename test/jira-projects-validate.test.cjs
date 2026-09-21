'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

// jiraProjects.ts imports ./config at module load time, which resolves its
// file through electron's app.getPath. The mock MUST be installed before the
// first load of jiraProjects.ts (loadTs caches modules by filename for the
// life of this test file, so a load before the mock is in place would freeze
// in the real, unmocked config.ts for every later loadTs call too) — mocked
// exactly like test/config-write-notify.test.cjs, pointed at a throwaway dir.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-crud-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { validateJiraProjectBinding, listBindings, upsertBinding, removeBinding } = loadTs('src/main/jiraProjects.ts');
const { isRepo, getBranches } = loadTs('src/main/git.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-validate-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  spawnSync('git', ['branch', 'develop'], { cwd: dir });
  return dir;
}

const okDeps = (overrides = {}) => ({
  isRepo, getBranches, agentExists: () => true, testJiraKey: undefined, ...overrides
});

test('rejects an invalid key format before touching the filesystem', async () => {
  const res = await validateJiraProjectBinding(
    { key: 'burd', repo: '/nonexistent', baseBranch: 'develop', enabled: true },
    [],
    okDeps({ isRepo: () => { throw new Error('should not be called'); } })
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /uppercase/i);
});

test('rejects a duplicate key (case-insensitive)', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'burd', repo: dir, baseBranch: 'develop', enabled: true },
    [{ key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }],
    okDeps()
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /already exists/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a repo path that does not exist', async () => {
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: '/definitely/not/a/real/path', baseBranch: 'develop', enabled: true },
    [], okDeps()
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /does not exist/i);
});

test('rejects a repo path that exists but is not a git repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-notrepo-'));
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }, [], okDeps()
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /not a git repo/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a base branch that does not exist locally or on origin', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'nope-branch', enabled: true }, [], okDeps()
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /branch/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts a base branch that only exists on origin/', async () => {
  const upstream = initRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-clone-'));
  spawnSync('git', ['clone', '-q', upstream, dir]);
  spawnSync('git', ['branch', '-D', 'develop'], { cwd: dir }); // local copy removed, origin/develop remains
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }, [], okDeps()
  );
  assert.equal(res.ok, true);
  fs.rmSync(upstream, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects an agent id that does not exist or is archived', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', agents: ['ghost'], enabled: true },
    [], okDeps({ agentExists: (id) => id !== 'ghost' })
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /agent/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skips the remote Jira key check when testJiraKey is not provided (integration not configured)', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }, [], okDeps({ testJiraKey: undefined })
  );
  assert.equal(res.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects when testJiraKey reports the project does not exist', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true },
    [], okDeps({ testJiraKey: async () => ({ ok: false, status: 404 }) })
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /jira/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts a fully valid binding', async () => {
  const dir = initRepo();
  const res = await validateJiraProjectBinding(
    { key: 'BURD', repo: dir, baseBranch: 'develop', agents: ['dwight'], enabled: true },
    [{ key: 'BRAVI', repo: dir, baseBranch: 'develop', enabled: true }],
    okDeps({ testJiraKey: async () => ({ ok: true, status: 200 }) })
  );
  assert.deepEqual(res, { ok: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- CRUD: listBindings/upsertBinding/removeBinding ---
// (electron/config mock installed at the top of this file, before the first
// loadTs('src/main/jiraProjects.ts') call — see the comment there.)

test('listBindings returns an empty list on a fresh config', () => {
  assert.deepEqual(listBindings(), []);
});

test('upsertBinding validates before writing — an invalid binding is rejected and not persisted', async () => {
  const res = await upsertBinding(
    { key: 'bad', repo: '/nope', baseBranch: 'develop', enabled: true },
    okDeps()
  );
  assert.equal(res.ok, false);
  assert.deepEqual(listBindings(), []);
});

test('upsertBinding persists a valid new binding', async () => {
  const dir = initRepo();
  const binding = { key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true };
  const res = await upsertBinding(binding, okDeps());
  assert.equal(res.ok, true);
  assert.deepEqual(listBindings(), [binding]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upsertBinding replaces an existing binding with the same key instead of duplicating it', async () => {
  const dir = initRepo();
  await upsertBinding({ key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }, okDeps());
  const updated = { key: 'BURD', repo: dir, baseBranch: 'develop', agents: ['dwight'], enabled: false };
  const res = await upsertBinding(updated, okDeps());
  assert.equal(res.ok, true);
  assert.deepEqual(listBindings(), [updated]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeBinding removes by key case-insensitively and is a no-op otherwise', async () => {
  const dir = initRepo();
  await upsertBinding({ key: 'BURD', repo: dir, baseBranch: 'develop', enabled: true }, okDeps());
  removeBinding('burd');
  assert.deepEqual(listBindings(), []);
  assert.deepEqual(removeBinding('GHOST'), []); // no-op, doesn't throw
  fs.rmSync(dir, { recursive: true, force: true });
});

test('magentoMcpConfig must be an absolute path to an existing file', async () => {
  const repo = initRepo();
  const deps = { isRepo, getBranches, agentExists: () => true };
  const base = { key: 'MAGX', repo, baseBranch: 'develop', enabled: true };
  const file = path.join(repo, 'm.json');
  fs.writeFileSync(file, '{}');
  assert.equal((await validateJiraProjectBinding({ ...base, magentoMcpConfig: file }, [], deps)).ok, true);
  assert.equal((await validateJiraProjectBinding(base, [], deps)).ok, true, 'optional');
  const rel = await validateJiraProjectBinding({ ...base, magentoMcpConfig: 'm.json' }, [], deps);
  assert.match(rel.error, /absolute/);
  const gone = await validateJiraProjectBinding({ ...base, magentoMcpConfig: path.join(repo, 'x.json') }, [], deps);
  assert.match(gone.error, /does not exist/);
});
