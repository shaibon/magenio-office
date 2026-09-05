'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { envAssignsNonEmpty, checkMcpPresence, installTrelloMcp } = loadTs('src/main/mcpProvision.ts');
const { TRELLO_MCP_TAG } = loadTs('src/shared/mcpCatalog.ts');

const GOOD_ENV = 'TRELLO_API_KEY=abc123\nTRELLO_TOKEN="s3cr3t-value"\n';

function presenceDeps(over) {
  return {
    fileExists: () => true,
    isExecutable: () => true,
    readText: () => GOOD_ENV,
    ...over
  };
}

const consent = { enabled: true, command: '/bin/bun', args: ['/pkg/build/index.js'] };

test('a fully configured, present, credentialed server passes', () => {
  assert.deepEqual(checkMcpPresence('trello', consent, presenceDeps()), { ok: true });
});

test('a consent with no command reports not_configured', () => {
  const result = checkMcpPresence('trello', { enabled: true }, presenceDeps());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('a missing or non-executable binary reports command_missing', () => {
  const missing = checkMcpPresence('trello', consent, presenceDeps({ fileExists: (p) => p !== '/bin/bun' }));
  assert.equal(missing.reason, 'command_missing');
  const notExec = checkMcpPresence('trello', consent, presenceDeps({ isExecutable: () => false }));
  assert.equal(notExec.reason, 'command_missing');
});

test('a missing entry file reports entry_missing', () => {
  const result = checkMcpPresence('trello', consent, presenceDeps({ fileExists: (p) => p !== '/pkg/build/index.js' }));
  assert.equal(result.reason, 'entry_missing');
});

test('a .env without TRELLO_TOKEN reports credentials_missing and names the key', () => {
  const result = checkMcpPresence('trello', consent, presenceDeps({ readText: () => 'TRELLO_API_KEY=abc123\n' }));
  assert.equal(result.reason, 'credentials_missing');
  assert.match(result.detail, /TRELLO_TOKEN/);
});

test('an absent .env reports credentials_missing', () => {
  const deps = presenceDeps({ fileExists: (p) => !p.endsWith('.env'), readText: () => null });
  assert.equal(checkMcpPresence('trello', consent, deps).reason, 'credentials_missing');
});

test('the preflight never discloses a credential value', () => {
  const result = checkMcpPresence('trello', consent, presenceDeps({ readText: () => 'TRELLO_API_KEY=abc123\n' }));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('abc123'), false, 'the preflight leaked a secret value');
});

test('envAssignsNonEmpty ignores comments, blanks and empty assignments', () => {
  assert.equal(envAssignsNonEmpty('# TRELLO_TOKEN=x\n', 'TRELLO_TOKEN'), false);
  assert.equal(envAssignsNonEmpty('TRELLO_TOKEN=\n', 'TRELLO_TOKEN'), false);
  assert.equal(envAssignsNonEmpty('TRELLO_TOKEN=""\n', 'TRELLO_TOKEN'), false);
  assert.equal(envAssignsNonEmpty('export TRELLO_TOKEN=abc\n', 'TRELLO_TOKEN'), true);
});

test('a non-trello entry is not credential-checked', () => {
  const result = checkMcpPresence('something-else', consent, presenceDeps({ readText: () => '' }));
  assert.deepEqual(result, { ok: true });
});

function installDeps(over) {
  const calls = [];
  return {
    calls,
    deps: {
      dirExistsNonEmpty: () => false,
      which: () => '/bin/bun',
      run: (cmd, args, cwd) => { calls.push({ cmd, args, cwd }); return { ok: true }; },
      fileExists: () => true,
      copyFile: (from, to) => { calls.push({ cmd: 'copy', args: [from, to] }); },
      ...over
    }
  };
}

test('install refuses a destination that already has content', async () => {
  const { deps, calls } = installDeps({ dirExistsNonEmpty: () => true });
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /not empty/i);
  assert.equal(calls.length, 0, 'it must not touch a non-empty destination');
});

test('install fails before cloning when bun is missing', async () => {
  const { deps, calls } = installDeps({ which: () => null });
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /bun/i);
  assert.equal(calls.length, 0, 'it must not clone before checking the toolchain');
});

test('install clones the pinned tag, never a branch', async () => {
  const { deps, calls } = installDeps();
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.ok, true);
  const clone = calls.find((c) => c.cmd === 'git');
  assert.ok(clone, 'no git clone was run');
  assert.ok(clone.args.includes('--branch'));
  assert.ok(clone.args.includes(TRELLO_MCP_TAG));
  assert.equal(clone.args.includes('main'), false);
});

test('install returns the command and args the UI pre-fills', async () => {
  const { deps } = installDeps();
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.command, '/bin/bun');
  assert.deepEqual(result.args, ['/dest/build/index.js']);
});

test('install reports the failing step instead of leaving a half-built dir silently', async () => {
  const { deps } = installDeps({ run: (cmd) => (cmd === 'git' ? { ok: true } : { ok: false, stderr: 'build blew up' }) });
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /build blew up/);
});
