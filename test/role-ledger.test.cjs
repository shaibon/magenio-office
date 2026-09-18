'use strict';

// t-056 review fix — the privileged-role ledger.
//
// The defect: the role granting the broker token and the role-scoped Trello
// server was re-read at spawn from registry.json, inside the hive root, which is
// one of the directories agents may write (`sandboxWritableDirs`). Writing
// `role: PM` there promoted an agent on the next restart.
//
// The fix: privilege now comes from an app-owned ledger in the Electron userData
// directory, which is not in any agent's writable set, and is written ONCE per
// agent id from the role the spawn request carried. This file covers both halves:
// the pure ledger rules, and the HiveManager decision itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-role-ledger-'));
const hiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-role-hive-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => appData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { emptyRoleLedger, normalizeRoleLedger, ledgerRole, rememberLedgerRole } = loadTs('src/shared/roleLedger.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

test.after(() => {
  fs.rmSync(appData, { recursive: true, force: true });
  fs.rmSync(hiveRoot, { recursive: true, force: true });
});

const PM_ROLE = 'Project manager: routes tasks, tracks Jira, gates QA sign-off, reports to the Boss';
const ledgerFile = (dir) => path.join(dir, 'agent-roles.json');

test('normalizeRoleLedger tolerates anything and keeps only durable roles', () => {
  assert.deepEqual(normalizeRoleLedger(undefined), emptyRoleLedger());
  assert.deepEqual(normalizeRoleLedger('not json'), emptyRoleLedger());
  assert.deepEqual(normalizeRoleLedger({ roles: 'nope' }), emptyRoleLedger());
  assert.deepEqual(
    normalizeRoleLedger({ roles: { a: `  ${PM_ROLE}  `, b: 'on standby', c: 42, d: '' } }),
    { version: 1, roles: { a: PM_ROLE } }
  );
});

test('rememberLedgerRole records a durable role and ignores captions/blanks', () => {
  const ledger = emptyRoleLedger();
  assert.equal(rememberLedgerRole(ledger, 'a', 'on standby'), false, 'a status caption is not a job');
  assert.equal(rememberLedgerRole(ledger, 'a', ''), false);
  assert.equal(rememberLedgerRole(ledger, 'a', undefined), false);
  assert.equal(ledgerRole(ledger, 'a'), '');
  assert.equal(rememberLedgerRole(ledger, 'a', ` ${PM_ROLE} `), true);
  assert.equal(ledgerRole(ledger, 'a'), PM_ROLE, 'stored trimmed');
});

test('onlyIfAbsent keeps the FIRST app-recorded role (a later spawn cannot promote)', () => {
  const ledger = emptyRoleLedger();
  assert.equal(rememberLedgerRole(ledger, 'a', 'Adobe Commerce backend developer', { onlyIfAbsent: true }), true);
  assert.equal(rememberLedgerRole(ledger, 'a', PM_ROLE, { onlyIfAbsent: true }), false, 'never overwritten');
  assert.equal(ledgerRole(ledger, 'a'), 'Adobe Commerce backend developer');
  // Without the flag the operator-facing path may still correct an entry.
  assert.equal(rememberLedgerRole(ledger, 'a', PM_ROLE), true);
  assert.equal(ledgerRole(ledger, 'a'), PM_ROLE);
});

test('a role in registry.json is NOT a privilege — the defect this fixes', () => {
  // The agent has written `role: PM` into its own registry entry, exactly the
  // self-promotion the security review found. Nothing in the app-owned ledger
  // backs it, so it grants nothing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-role-poisoned-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'md-role-empty-'));
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({
    godId: 'god',
    agents: {
      'worker-1': { id: 'worker-1', name: 'Worker', cwd: '/tmp', role: PM_ROLE, status: 'idle', lastSeen: 0 },
      'worker-2': { id: 'worker-2', name: 'Worker', cwd: '/tmp', role: 'PM', capabilities: ['project manager'], status: 'idle', lastSeen: 0 }
    }
  }));
  const hive = new HiveManager(() => root, undefined, () => data);
  assert.equal(hive.privilegedRole('worker-1'), '', 'registry.json is display state, never a privilege');
  assert.equal(hive.isPrivilegedPm('worker-1'), false);
  assert.equal(hive.isPrivilegedPm('worker-2'), false);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

test('the ledger grants the privilege, and remembering it happens once per id', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'md-role-grant-'));
  const hive = new HiveManager(() => hiveRoot, undefined, () => data);
  assert.equal(hive.isPrivilegedPm('pam-9'), false, 'nothing recorded yet → no privilege');

  hive['rememberPrivilegedRole']('pam-9', PM_ROLE);
  assert.equal(hive.privilegedRole('pam-9'), PM_ROLE);
  assert.equal(hive.isPrivilegedPm('pam-9'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile(data), 'utf8')).roles, { 'pam-9': PM_ROLE });

  // A later spawn carrying a DIFFERENT role must not rewrite it (first sighting
  // wins), and a caption must not be recorded at all.
  hive['rememberPrivilegedRole']('pam-9', 'on standby');
  hive['rememberPrivilegedRole']('pam-9', 'Adobe Commerce backend developer');
  hive['rememberPrivilegedRole']('pam-10', 'idle');
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile(data), 'utf8')).roles, { 'pam-9': PM_ROLE });

  // A fresh instance reads the same file — privilege survives a restart, which
  // is the whole point of recording it app-side rather than in memory only.
  const restarted = new HiveManager(() => hiveRoot, undefined, () => data);
  assert.equal(restarted.isPrivilegedPm('pam-9'), true);
  fs.rmSync(data, { recursive: true, force: true });
});

test('with no app-data dir there is no ledger and therefore no role privilege (fail-closed)', () => {
  const hive = new HiveManager(() => hiveRoot);
  assert.equal(hive.privilegedRole('pam-1'), '');
  assert.equal(hive.isPrivilegedPm('pam-1'), false);
});
