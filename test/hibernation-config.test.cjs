'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts resolves its file through Electron's app.getPath(); use a throwaway userData root.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hib-cfg-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const file = path.join(userData, 'config.json');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('t-283: a fresh install has hibernation ON, 15 minutes, nobody opted out', () => {
  fs.rmSync(file, { force: true });
  const c = readConfig();
  assert.equal(c.agentHibernateEnabled, true);
  assert.equal(c.agentHibernateMinutes, 15);
  assert.deepEqual(c.hibernateOptOutAgents, []);
});

test('t-283: a phase-2a config (minutes 0, opt-in list) migrates to the new default ON', () => {
  fs.writeFileSync(file, JSON.stringify({ agentHibernateMinutes: 0, hibernateOptInAgents: ['pam'], registeredRepos: ['/x'] }));
  const c = readConfig();
  assert.equal(c.agentHibernateEnabled, true);
  assert.equal(c.agentHibernateMinutes, 15);
  assert.equal('hibernateOptInAgents' in c, false);
  assert.deepEqual(c.registeredRepos, ['/x'], 'unrelated settings untouched');
});

test('t-283: an explicit choice survives (off switch, minutes, opt-outs); junk is sanitized', () => {
  fs.writeFileSync(file, JSON.stringify({ agentHibernateEnabled: false, agentHibernateMinutes: 7, hibernateOptOutAgents: ['jim', 3, '', null] }));
  const c = readConfig();
  assert.equal(c.agentHibernateEnabled, false);
  assert.equal(c.agentHibernateMinutes, 7);
  assert.deepEqual(c.hibernateOptOutAgents, ['jim']);
  fs.writeFileSync(file, JSON.stringify({ agentHibernateMinutes: 'soon', hibernateOptOutAgents: 'jim' }));
  const d = readConfig();
  assert.equal(d.agentHibernateMinutes, 15);
  assert.deepEqual(d.hibernateOptOutAgents, []);
});

test('t-283: a saved change is read back on the next beat (hot apply, no restart)', () => {
  fs.rmSync(file, { force: true });
  writeConfig({ agentHibernateEnabled: false, agentHibernateMinutes: 5 });
  assert.equal(readConfig().agentHibernateEnabled, false);
  writeConfig({ agentHibernateEnabled: true });
  assert.equal(readConfig().agentHibernateEnabled, true);
  assert.equal(readConfig().agentHibernateMinutes, 5);
});

test('t-283 I4: an absent switch is ON, a present-but-mangled one reads as OFF (fail closed)', () => {
  fs.writeFileSync(file, JSON.stringify({ registeredRepos: [] }));
  assert.equal(readConfig().agentHibernateEnabled, true);
  for (const bad of ['false', 0, null, 'no', {}]) {
    fs.writeFileSync(file, JSON.stringify({ agentHibernateEnabled: bad }));
    assert.equal(readConfig().agentHibernateEnabled, false, JSON.stringify(bad));
  }
});
