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

test('perAgent: only the agent with that id gets network, others keep the global value', () => {
  const { codexSandboxForAgent } = loadTs('src/shared/codexSandbox.ts');
  const cfg = { networkAccess: false, extraWritableDirs: ['/g'], perAgent: { god: { networkAccess: true, extraWritableDirs: ['/e'] } } };
  const god = codexSandboxForAgent(cfg, 'god');
  assert.deepEqual(god, { networkAccess: true, extraWritableDirs: ['/g', '/e'] });
  assert.deepEqual(codexSandboxArgs(god), ['-c', 'sandbox_workspace_write.network_access=true', '--add-dir', '/g', '--add-dir', '/e']);
  const other = codexSandboxForAgent(cfg, 'a-123');
  assert.deepEqual(other, { networkAccess: false, extraWritableDirs: ['/g'] });
  assert.deepEqual(codexSandboxArgs(other), ['--add-dir', '/g']);
});
test('perAgent: exact id match only — no case folding, no name lookup, no prototype keys', () => {
  const { codexSandboxForAgent } = loadTs('src/shared/codexSandbox.ts');
  const cfg = { perAgent: { god: { networkAccess: true } } };
  assert.deepEqual(codexSandboxForAgent(cfg, 'God'), {});
  assert.deepEqual(codexSandboxForAgent(cfg, 'Elliot'), {});
  assert.deepEqual(codexSandboxForAgent(cfg, 'toString'), {});
  assert.deepEqual(codexSandboxForAgent(cfg, '__proto__'), {});
});
test('perAgent: ephemeral workers never get an override, even with a matching key', () => {
  const { codexSandboxForAgent } = loadTs('src/shared/codexSandbox.ts');
  const cfg = { perAgent: { 'worker-x': { networkAccess: true } } };
  assert.deepEqual(codexSandboxArgs(codexSandboxForAgent(cfg, 'worker-x')), []);
});
test('perAgent: absent map, missing id or unknown agent → global block unchanged', () => {
  const { codexSandboxForAgent } = loadTs('src/shared/codexSandbox.ts');
  assert.equal(codexSandboxForAgent(undefined, 'god'), undefined);
  assert.deepEqual(codexSandboxForAgent({ networkAccess: true }, 'god'), { networkAccess: true });
  assert.deepEqual(codexSandboxForAgent({ perAgent: { god: { networkAccess: true } } }, undefined), {});
});
test('perAgent: an override can turn network OFF for one agent', () => {
  const { codexSandboxForAgent } = loadTs('src/shared/codexSandbox.ts');
  const cfg = { networkAccess: true, perAgent: { 'a-1': { networkAccess: false } } };
  assert.deepEqual(codexSandboxArgs(codexSandboxForAgent(cfg, 'a-1')), []);
  assert.deepEqual(codexSandboxArgs(codexSandboxForAgent(cfg, 'a-2')), ['-c', 'sandbox_workspace_write.network_access=true']);
});
test('perAgent: danger mode is not overridable per agent and junk values are ignored', () => {
  const { codexSandboxForAgent } = loadTs('src/shared/codexSandbox.ts');
  const cfg = { perAgent: { god: { dangerFullAccess: true, networkAccess: 'yes', extraWritableDirs: [3, '/ok'] } } };
  assert.deepEqual(codexSandboxForAgent(cfg, 'god'), { extraWritableDirs: ['/ok'] });
});
