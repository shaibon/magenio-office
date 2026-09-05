'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const LOCALES = ['en', 'zh-CN', 'ar'];
const KEYS = [
  'command', 'commandHint', 'commandPlaceholder',
  'args', 'argsHint', 'argsPlaceholder',
  'agents', 'agentsHint', 'agentsPlaceholder',
  'setupTitle', 'setupIntro', 'setupAfter',
  'install', 'installDest', 'installing', 'installFailed', 'presenceOk',
  'presence.not_configured', 'presence.command_missing',
  'presence.entry_missing', 'presence.credentials_missing'
];

// A placeholder shows a REAL example of what the field wants, so its value is
// a literal path or id — not prose. Translating one would teach the user to
// type a path that does not exist, which is worse than no example at all.
const UNTRANSLATED_KEYS = ['commandPlaceholder', 'argsPlaceholder', 'agentsPlaceholder'];

// Keys whose translated string must keep its i18next interpolation
// placeholder verbatim — losing it during translation would silently drop
// the error/detail text at render time in every locale but the one that was
// checked by hand.
const PLACEHOLDER_KEYS = [
  ['installFailed', '{{error}}'],
  // Spec §E: Install shows its destination BEFORE proceeding. A locale that
  // dropped {{path}} would render a promise with no path in it.
  ['installDest', '{{path}}'],
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

test('the example placeholders are identical in every locale', () => {
  const en = read('en').mcpDefaults;
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    const other = read(locale).mcpDefaults;
    for (const key of UNTRANSLATED_KEYS) {
      assert.equal(
        other[key], en[key],
        `${locale} translated mcpDefaults.${key} — a placeholder is a literal example, not prose`
      );
    }
  }
});

test('the first-run setup block leads with install and is gated by the install rule', () => {
  // No DOM harness in this repo, so the rendering is covered by inspection.
  // What is checked here is the property that matters: the setup call to
  // action lives behind the SAME guard as the button it introduces, so a
  // state install cannot fix (credentials_missing) never shows one, and the
  // block sits ABOVE the manual fields it tells the user about.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');

  for (const key of ['setupTitle', 'setupIntro', 'setupAfter']) {
    assert.match(src, new RegExp(`mcpDefaults\\.${key}`), `the setup block must render ${key}`);
  }

  const setup = src.indexOf("mcpDefaults.setupTitle");
  const commandField = src.indexOf("mcpDefaults.command'");
  assert.ok(setup > -1 && commandField > -1);
  assert.ok(
    setup < commandField,
    'the setup block must come before the manual fields — leading with three empty inputs is what sent users looking for the answer elsewhere'
  );

  // The guard: the setup block and the button are inside one canInstallMcp
  // branch, so there is exactly one of them in the file.
  assert.equal(
    (src.match(/canInstallMcp\(entry\.id, presence\[entry\.id\]\)/g) ?? []).length,
    1,
    'the setup block and its install button must share a single canInstallMcp guard'
  );
});

test('each configurable field offers an example placeholder', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  for (const key of ['commandPlaceholder', 'argsPlaceholder', 'agentsPlaceholder']) {
    assert.match(src, new RegExp(`placeholder=\\{t\\('mcpDefaults\\.${key}'\\)\\}`), `${key} must be wired to its field`);
  }
  assert.match(src, /placeholder\?: string/, 'ConsentField must accept a placeholder');
  assert.equal(
    (src.match(/placeholder=\{placeholder\}/g) ?? []).length,
    2,
    'ConsentField must pass the placeholder to BOTH its input and its textarea'
  );
});

test('the component renders the extra fields only for user-configured entries', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(src, /userConfigured/, 'the extra fields must be gated on the catalog flag');
  assert.match(src, /mcpPresence/, 'the preflight state must be shown');
  assert.match(src, /mcpInstall/, 'the install action must be wired');

  // The credentials_missing rule itself lives in mcpInstallRule.ts (a plain
  // .ts module, imported and applied by the component's install button) —
  // exercised behaviourally below in "canInstallMcp: behaviour for every
  // branch". Check both files together so this assertion still fails if
  // the rule ever stops being wired into the component at all.
  const ruleSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/mcpInstallRule.ts'), 'utf8');
  assert.match(src, /canInstallMcp/, 'the install button must be gated by the install rule');
  assert.match(ruleSrc, /credentials_missing/, 'the install rule must account for credentials_missing');
});

test('the install destination is shown next to the button, and only ever displayed', () => {
  // Spec §E. This repo has no DOM harness, so the rendering itself is covered
  // by inspection; what is checked here is the property that matters for
  // safety — the renderer DISPLAYS main's path and never builds or sends one.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(src, /mcpDefaults\.installDest/, 'the destination must be rendered through the i18n key');
  assert.match(src, /presence\[entry\.id\]\?\.installDest/, 'the path must come from the preflight result main returned');
  assert.equal(
    /mcpInstall\([^)]*(dest|path|join|userData)/i.test(src),
    false,
    'the renderer must never send a path to the installer'
  );
});

test('the consent writer materializes entries through the shared catalog merge', () => {
  // The allow-list seed is behaviour of mergeMcpConsent (exercised for real in
  // trello-mcp-catalog.test.cjs). This checks the component still routes its
  // writes through it rather than re-growing a hand-rolled spread that would
  // drop the seed again.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(src, /mergeMcpConsent\(id, base\[id\], patch\)/, 'consent writes must go through mergeMcpConsent');
});

test('canInstallMcp: behaviour for every branch', () => {
  const { canInstallMcp } = loadTs('src/renderer/src/components/mcpInstallRule.ts');

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
