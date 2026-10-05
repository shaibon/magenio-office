'use strict';

// An agent's shared `project` label must come from the REPO it works on, not from a
// binding's `agents` list. `agents` says who CLAIMS a project's cards, and in practice
// every binding names only its own roster (one Pam per project), so keying membership
// off it dropped every other agent of the same repo to the folder basename: the floor
// split into "BRAVI" and "magenio-M2-bravifarmacie" for the same repository.
//
// Served by projectKeyForAgent, used by resolveAgentProject in src/main/index.ts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { projectKeyForAgent } = loadTs('src/main/jiraProjects.ts');

/** A binding with only the fields the selector reads. */
const binding = (key, repo, agents, enabled = true) => ({ key, repo, baseBranch: 'develop', agents, enabled });

const REPO_A = '/Users/me/www/magenio-M2-bravifarmacie';
const REPO_B = '/Users/me/www/magenio-M2-ristosubito';

test('the claiming agent still gets its own binding', () => {
  const bindings = [binding('BRAVI', REPO_A, ['pam-mtidf2bl']), binding('RISTO', REPO_B, ['pam-mtlbwbux'])];
  assert.equal(projectKeyForAgent(bindings, 'pam-mtidf2bl', REPO_A), 'BRAVI');
  assert.equal(projectKeyForAgent(bindings, 'pam-mtlbwbux', REPO_B), 'RISTO');
});

test('an agent the binding does not list still belongs to its repo\'s project', () => {
  const bindings = [binding('BRAVI', REPO_A, ['pam-mtidf2bl']), binding('RISTO', REPO_B, ['pam-mtlbwbux'])];
  // The defect: this used to answer null, so resolveAgentProject fell through to the
  // basename and the floor showed two groups for one repo.
  assert.equal(projectKeyForAgent(bindings, 'dwight-mtidfn2h', REPO_A), 'BRAVI');
  assert.equal(projectKeyForAgent(bindings, 'andy-mtiqqouu', REPO_A), 'BRAVI');
  assert.equal(projectKeyForAgent(bindings, 'phyllis-mtlbwuqb', REPO_B), 'RISTO');
});

test('a binding with no agents list covers every agent of that repo', () => {
  const bindings = [binding('BRAVI', REPO_A, undefined), binding('BRAVI', REPO_A, [])];
  assert.equal(projectKeyForAgent([bindings[0]], 'whoever', REPO_A), 'BRAVI');
  assert.equal(projectKeyForAgent([bindings[1]], 'whoever', REPO_A), 'BRAVI');
});

test('an unbound repo has no opinion — the folder name stays the label', () => {
  const bindings = [binding('BRAVI', REPO_A, ['pam-mtidf2bl'])];
  assert.equal(projectKeyForAgent(bindings, 'andy-mtiqqouu', REPO_B), null);
  assert.equal(projectKeyForAgent(bindings, 'andy-mtiqqouu', null), null);
});

test('two bindings on one repo are ambiguous — no label beats a wrong one', () => {
  const bindings = [binding('BRAVI', REPO_A, ['pam-mtidf2bl']), binding('VAI', REPO_A, ['pam-mtctnhm3'])];
  // Neither claims this agent, and the repo alone cannot say which project it is on.
  assert.equal(projectKeyForAgent(bindings, 'andy-mtiqqouu', REPO_A), null);
  // The agent a binding DOES claim is unambiguous even with a sibling binding.
  assert.equal(projectKeyForAgent(bindings, 'pam-mtctnhm3', REPO_A), 'VAI');
});

test('a disabled binding is not a candidate, and never claims', () => {
  const bindings = [binding('BRAVI', REPO_A, ['pam-mtidf2bl'], false)];
  assert.equal(projectKeyForAgent(bindings, 'pam-mtidf2bl', REPO_A), null);
  assert.equal(projectKeyForAgent(bindings, 'andy-mtiqqouu', REPO_A), null);
});

test('a disabled sibling does not make a single enabled binding ambiguous', () => {
  const bindings = [binding('BRAVI', REPO_A, ['pam-mtidf2bl']), binding('OLD', REPO_A, [], false)];
  assert.equal(projectKeyForAgent(bindings, 'andy-mtiqqouu', REPO_A), 'BRAVI');
});

test('resolveAgentProject labels through projectKeyForAgent, repo-first', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function resolveAgentProject'));
  assert.match(fn.slice(0, 900), /jiraProjects\.projectKeyForAgent\(/,
    'the shared label must be decided by the repo-first selector');
  assert.doesNotMatch(fn.slice(0, 900), /b\.agents\.includes\(meta\.id\)/,
    'membership must not be read off the binding claim list');
  // The folder basename stays the label when no binding owns the repo.
  assert.match(fn.slice(0, 900), /basename\(/);
});
