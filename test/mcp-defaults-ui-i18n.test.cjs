'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const LOCALES = ['en', 'zh-CN', 'ar'];
const KEYS = [
  'command', 'commandHint', 'args', 'argsHint', 'agents', 'agentsHint',
  'install', 'installing', 'installFailed', 'presenceOk',
  'presence.not_configured', 'presence.command_missing',
  'presence.entry_missing', 'presence.credentials_missing'
];

// Keys whose translated string must keep its i18next interpolation
// placeholder verbatim — losing it during translation would silently drop
// the error/detail text at render time in every locale but the one that was
// checked by hand.
const PLACEHOLDER_KEYS = [
  ['installFailed', '{{error}}'],
  ['presence.credentials_missing', '{{detail}}']
];

function read(locale) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${locale}.json`), 'utf8'));
}

function at(obj, dotted) {
  return dotted.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

for (const locale of LOCALES) {
  test(`${locale} has every new mcpDefaults string`, () => {
    const mcp = read(locale).mcpDefaults;
    assert.ok(mcp, `${locale} has no mcpDefaults block`);
    for (const key of KEYS) {
      const value = at(mcp, key);
      assert.ok(typeof value === 'string' && value.length > 0, `${locale} is missing mcpDefaults.${key}`);
    }
  });

  test(`${locale} keeps the interpolation placeholders in translated strings`, () => {
    const mcp = read(locale).mcpDefaults;
    for (const [key, placeholder] of PLACEHOLDER_KEYS) {
      const value = at(mcp, key);
      assert.ok(
        typeof value === 'string' && value.includes(placeholder),
        `${locale} mcpDefaults.${key} must contain ${placeholder} verbatim, got: ${JSON.stringify(value)}`
      );
    }
  });
}

test('the component renders the extra fields only for user-configured entries', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(src, /userConfigured/, 'the extra fields must be gated on the catalog flag');
  assert.match(src, /mcpPresence/, 'the preflight state must be shown');
  assert.match(src, /mcpInstall/, 'the install action must be wired');
  assert.match(src, /credentials_missing/, 'the install button must be hidden for credentials_missing');
});

test('canInstallMcp: behaviour for every branch', () => {
  const { canInstallMcp } = loadTs('src/renderer/src/components/McpDefaultsSettings.tsx');

  // Only trello ships an installer.
  assert.equal(canInstallMcp('some-other-entry', undefined), false, 'a non-trello entry must never show install');
  assert.equal(canInstallMcp('some-other-entry', { ok: false, reason: 'not_configured' }), false);

  // Never once the preflight is ok.
  assert.equal(canInstallMcp('trello', { ok: true }), false, 'ok:true must hide install');

  // Never for credentials_missing: no install can supply a secret.
  assert.equal(
    canInstallMcp('trello', { ok: false, reason: 'credentials_missing' }),
    false,
    'credentials_missing must hide install'
  );

  // Yes for the failure reasons an install can actually fix.
  assert.equal(canInstallMcp('trello', { ok: false, reason: 'not_configured' }), true);
  assert.equal(canInstallMcp('trello', { ok: false, reason: 'command_missing' }), true);
  assert.equal(canInstallMcp('trello', { ok: false, reason: 'entry_missing' }), true);

  // Absent/unknown reason (including "preflight hasn't run yet") defaults to
  // showing install rather than silently stranding the user.
  assert.equal(canInstallMcp('trello', undefined), true, 'no presence yet must default to showing install');
  assert.equal(canInstallMcp('trello', { ok: false }), true, 'no reason must default to showing install');
  assert.equal(
    canInstallMcp('trello', { ok: false, reason: 'some_future_reason' }),
    true,
    'an unrecognized reason must default to showing install'
  );
});
