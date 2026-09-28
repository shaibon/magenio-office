/**
 * Removing an integration must ask first.
 *
 * What started this: the ✕ next to an integration called
 * integrationsClient.remove() on the first click, with no confirmation. The
 * owner of this app deleted the Jira integration by accident that way and the
 * whole Jira pipeline stopped — and because the stored key goes with the
 * integration, nothing in the UI could bring it back. The fix is a destructive
 * confirm that names the integration and says the key is lost.
 *
 * Source-string checks, because IntegrationsRegistry is a React component and
 * this repo has no jsdom harness; the point is that deleting the confirm
 * wiring must not pass silently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');
const SRC = read('src/renderer/src/components/IntegrationsRegistry.tsx');

test('the click only arms the confirm, it never removes', () => {
  assert.match(SRC, /const onRemove = \(r: IntegrationRecordView\) => setPendingRemove\(r\);/,
    'onRemove must just arm the confirm; if it removes directly the click is destructive again');
  const onRemoveBody = SRC.slice(SRC.indexOf('const onRemove ='), SRC.indexOf('const doRemove ='));
  assert.ok(!/integrationsClient\.remove/.test(onRemoveBody),
    'the arming path must not reach integrationsClient.remove');
  assert.equal((SRC.match(/integrationsClient\.remove\(/g) || []).length, 1,
    'exactly one call site for remove — it lives behind the confirm');
});

test('the remove call sits behind the confirm', () => {
  const doRemoveBody = SRC.slice(SRC.indexOf('const doRemove ='), SRC.indexOf('const fmtTest ='));
  assert.ok(/integrationsClient\.remove\(r\.id\)/.test(doRemoveBody),
    'doRemove is the only path that actually removes');
  assert.ok(/setPendingRemove\(null\)/.test(doRemoveBody),
    'the confirm closes once the removal settles');
});

test('the confirm renders, names the integration, and warns about the key', () => {
  assert.match(SRC, /\{pendingRemove && \(\s*<RemoveIntegrationConfirmModal/,
    'the modal must render while a removal is pending');
  assert.match(SRC, /onConfirm=\{\(\) => \{ void doRemove\(pendingRemove\); \}\}/,
    'confirming is what triggers the removal');
  assert.match(SRC, /onCancel=\{\(\) => setPendingRemove\(null\)\}/,
    'cancelling must drop the pending removal without touching the integration');
  assert.match(SRC, /t\('integrations\.confirmRemoveTitle', \{ label \}\)/,
    'the confirm names the integration being removed');
  assert.match(SRC, /t\('integrations\.confirmRemoveBody', \{ label \}\)/,
    'the body explains the consequence, including the lost key');
});

for (const locale of ['en', 'zh-CN', 'ar']) {
  test(`${locale} carries the confirm strings`, () => {
    const d = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}.json`));
    for (const key of ['confirmRemoveTitle', 'confirmRemoveLead', 'confirmRemoveBody', 'confirmRemoveCta']) {
      assert.ok(d.integrations[key], `${locale}: integrations.${key} is missing`);
    }
    assert.match(d.integrations.confirmRemoveTitle, /\{\{label\}\}/,
      `${locale}: the title must interpolate the integration label`);
  });
}
