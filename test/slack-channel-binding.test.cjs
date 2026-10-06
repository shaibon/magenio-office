'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const J = loadTs('src/shared/jiraProjects.ts');
const { bindingFromDraft, draftFromBinding } = loadTs('src/renderer/src/components/jiraProjectDraft.ts');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-slackbind-'));
let cur = userData;
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => cur } } };
const { readConfig, resetConfig } = loadTs('src/main/config.ts');
const JP = loadTs('src/main/jiraProjects.ts');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const b = (key, over = {}) => ({ key, repo: '/r/' + key, baseBranch: 'main', enabled: true, ...over });
const LEGACY = { CSXE9V0AF: 'VAI', C03G9FGU2RE: 'BURD', CBCT8Q00Z: 'RISTO', CCLJJGXU4: 'BRAVI' };

test('resolver: binding wins, legacy is fallback, unmapped/disabled/blank = null', () => {
  const bs = [b('BRAVI', { slackChannels: ['CCLJJGXU4', 'C0MULTI123'] }), b('OFF', { enabled: false, slackChannels: ['C0DISABLED'] })];
  assert.equal(J.resolveSlackProject(bs, 'C0MULTI123'), 'BRAVI');
  assert.equal(J.resolveSlackProject(bs, 'ccljjgxu4'), 'BRAVI');
  assert.equal(J.resolveSlackProject(bs, 'C03G9FGU2RE', LEGACY), 'BURD');          // fallback
  assert.equal(J.resolveSlackProject([b('X', { slackChannels: ['C03G9FGU2RE'] })], 'C03G9FGU2RE', LEGACY), 'X'); // binding beats legacy
  assert.equal(J.resolveSlackProject(bs, 'C0DISABLED'), null);
  assert.equal(J.resolveSlackProject(bs, 'C0UNKNOWN9', LEGACY), null);
  assert.equal(J.resolveSlackProject(bs, ''), null);
});

test('resolver: disabled binding or removed channel is authoritative over the legacy map (Toby)', () => {
  assert.equal(J.resolveSlackProject([b('BURD', { enabled: false, slackChannels: ['C03G9FGU2RE'] })], 'C03G9FGU2RE', LEGACY), null);
  assert.equal(J.resolveSlackProject([b('BURD', { slackChannels: [] })], 'C03G9FGU2RE', LEGACY), null);
  assert.equal(J.resolveSlackProject([b('BURD')], 'C03G9FGU2RE', LEGACY), null);
  assert.equal(J.resolveSlackProject([b('BRAVI')], 'C03G9FGU2RE', LEGACY), 'BURD'); // project unbound: fallback
});

test('parseSlackChannelsJson: project map, ALL and garbage ignored', () => {
  assert.deepEqual(J.parseSlackChannelsJson(JSON.stringify({ channels: { CAAAAAAAA: { project: 'vai' }, CBBBBBBBB: { project: 'ALL' }, CCCCCCCCC: {} } })), { CAAAAAAAA: 'VAI' });
  assert.deepEqual(J.parseSlackChannelsJson('not json'), {});
});

test('validation: format and one-project-per-channel', () => {
  assert.equal(J.validateSlackChannels(['C03G9FGU2RE'], []), null);
  assert.match(J.validateSlackChannels(['#general'], []), /not a Slack channel id/);
  assert.match(J.validateSlackChannels(['C03G9FGU2RE'], [b('BURD', { slackChannels: ['C03G9FGU2RE'] })]), /already bound to BURD/);
  assert.equal(J.validateSlackChannels(undefined, []), null);
});

test('importSlackChannels maps by project key, skips bound ids, no-op returns same array', () => {
  const bs = [b('BURD'), b('BRAVI', { slackChannels: ['CCLJJGXU4'] }), b('NOPE')];
  const out = J.importSlackChannels(bs, LEGACY);
  assert.deepEqual(out[0].slackChannels, ['C03G9FGU2RE']);
  assert.deepEqual(out[1].slackChannels, ['CCLJJGXU4']);
  assert.equal(out[2].slackChannels, undefined);
  assert.equal(J.importSlackChannels([b('NOPE')], LEGACY).length, 1);
  const same = [b('NOPE')];
  assert.equal(J.importSlackChannels(same, LEGACY), same);
});

test('form draft round-trips a channel list and drops blanks/duplicates', () => {
  const d = draftFromBinding(b('BURD', { slackChannels: ['C03G9FGU2RE', 'CBCT8Q00Z'] }));
  assert.equal(d.slackChannels, 'C03G9FGU2RE, CBCT8Q00Z');
  assert.deepEqual(bindingFromDraft({ ...d, slackChannels: ' c03g9fgu2re ,, CBCT8Q00Z\nc03g9fgu2re ' }).slackChannels, ['C03G9FGU2RE', 'CBCT8Q00Z']);
  assert.equal('slackChannels' in bindingFromDraft({ ...d, slackChannels: ' , ' }), false);
});

function profile(name, cfg, legacy) {
  const dir = path.join(userData, name);
  fs.mkdirSync(path.join(dir, 'hive'), { recursive: true });
  cur = dir; resetConfig();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ harnessHome: dir, jiraProjectsImported: true, ...cfg }));
  if (legacy) fs.writeFileSync(path.join(dir, 'hive', 'slack-channels.json'), JSON.stringify({ channels: Object.fromEntries(Object.entries(legacy).map(([id, project]) => [id, { name: id, project }])) }));
  return dir;
}

test('migration: legacy file folded into bindings once, file untouched, persisted latch', () => {
  const dir = profile('mig', { jiraProjects: [b('BURD'), b('BRAVI')] }, LEGACY);
  const before = fs.readFileSync(path.join(dir, 'hive', 'slack-channels.json'), 'utf8');
  const cfg = readConfig();
  assert.deepEqual(cfg.jiraProjects.find((x) => x.key === 'BURD').slackChannels, ['C03G9FGU2RE']);
  assert.deepEqual(cfg.jiraProjects.find((x) => x.key === 'BRAVI').slackChannels, ['CCLJJGXU4']);
  assert.equal(cfg.slackChannelsImported, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).slackChannelsImported, true);
  assert.equal(fs.readFileSync(path.join(dir, 'hive', 'slack-channels.json'), 'utf8'), before);
  assert.equal(JP.slackProjectFor('C03G9FGU2RE'), 'BURD');
  assert.equal(JP.slackProjectFor('CVAIONLY1') , null);
});

test('migration: not re-run after the user removes a channel on purpose', () => {
  profile('latched', { jiraProjects: [b('BURD')], slackChannelsImported: true }, LEGACY);
  assert.equal(readConfig().jiraProjects[0].slackChannels, undefined);
  assert.equal(JP.slackProjectFor('C03G9FGU2RE'), null); // BURD has a binding: removal is authoritative, legacy does not resurrect it
  assert.equal(JP.slackProjectFor('CBCT8Q00Z'), 'RISTO');  // no RISTO binding: legacy fallback still answers
});

test('migration: waits (no latch) while there are no bindings', () => {
  profile('nobind', { jiraProjects: [] }, LEGACY);
  assert.equal(readConfig().slackChannelsImported, undefined);
});
