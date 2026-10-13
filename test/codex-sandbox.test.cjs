'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { codexSandboxArgs, withCodexSandboxMode } = loadTs('src/shared/codexSandbox.ts');

test('default (absent/empty) adds nothing — network stays OFF', () => {
  assert.deepEqual(codexSandboxArgs(undefined), []);
  assert.deepEqual(codexSandboxArgs({}), []);
  assert.deepEqual(codexSandboxArgs({ networkAccess: false }), []);
});
test('networkAccess + extra dirs', () => {
  assert.deepEqual(codexSandboxArgs({ networkAccess: true, extraWritableDirs: ['/a', ' ', '/b '] }),
    ['-c', 'sandbox_workspace_write.network_access=true', '--add-dir', '/a', '--add-dir', '/b']);
});
test('danger mode: no -c args, sandbox flag swapped, other args untouched', () => {
  assert.deepEqual(codexSandboxArgs({ dangerFullAccess: true, networkAccess: true }), []);
  const base = ['-a', 'never', '-s', 'workspace-write', 'workspace-write'];
  assert.deepEqual(withCodexSandboxMode(base, { dangerFullAccess: true }), ['-a', 'never', '-s', 'danger-full-access', 'workspace-write']);
  assert.equal(withCodexSandboxMode(base, { networkAccess: true }), base);
});

test('command string swap', () => {
  const { withCodexSandboxCommand } = loadTs('src/shared/codexSandbox.ts');
  assert.equal(withCodexSandboxCommand('codex -a never -s workspace-write', { dangerFullAccess: true }), 'codex -a never -s danger-full-access');
  assert.equal(withCodexSandboxCommand('codex -s workspace-write', {}), 'codex -s workspace-write');
});
