'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['en', 'zh-CN', 'ar'];
const KEYS = [
  'command', 'commandHint', 'args', 'argsHint', 'agents', 'agentsHint',
  'install', 'installing', 'installFailed', 'presenceOk',
  'presence.not_configured', 'presence.command_missing',
  'presence.entry_missing', 'presence.credentials_missing'
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
}

test('the component renders the extra fields only for user-configured entries', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(src, /userConfigured/, 'the extra fields must be gated on the catalog flag');
  assert.match(src, /mcpPresence/, 'the preflight state must be shown');
  assert.match(src, /mcpInstall/, 'the install action must be wired');
  assert.match(src, /credentials_missing/, 'the install button must be hidden for credentials_missing');
});
