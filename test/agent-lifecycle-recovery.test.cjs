'use strict';

/**
 * t-042 + t-043 — an archived agent, and an archived+FROZEN agent, must always
 * have a way back onto the floor.
 *
 * Archived agents are shown only in the Command Center's Archived list, and
 * that list used to offer ONE action: the destructive ✕ (removeArchivedAgent).
 * Frozen state lives in config.autoDeliveryPausedAgents and is per-agent, but
 * Unfreeze was only drawn inside the restorable dropdown (AgentStrip), which an
 * archived agent is never in. So an agent that was archived AND frozen had no
 * path back at all.
 *
 * These are source-scan tests (same convention as
 * frozen-agent-unfreeze-reachability.test.cjs / agent-project-tag-wiring.test.cjs):
 * the touched components are JSX with a wide import graph and this repo has no
 * render-test harness. They pin the WIRING: the restore helper reuses the one
 * id-preserving spawn recipe, and every surface that can show a frozen agent
 * can also unfreeze it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const FILES = {
  restore: 'src/renderer/src/hooks/useRestoreTeam.ts',
  card: 'src/renderer/src/components/AgentCard.tsx',
  strip: 'src/renderer/src/components/AgentStrip.tsx',
  commandCenter: 'src/renderer/src/components/CommandCenterPanel.tsx',
  detail: 'src/renderer/src/components/AgentDetailPanel.tsx',
  fullscreen: 'src/renderer/src/components/FullscreenTerminal.tsx',
  app: 'src/renderer/src/App.tsx'
};

/** Return the source between two markers (first occurrence of each). */
function between(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b >= 0, `end marker not found: ${to}`);
  return src.slice(a, b + to.length);
}

/** The whole Archived-section row body, from map open to map close. */
function archivedRow() {
  const section = between(
    strip(read(FILES.commandCenter)),
    'function ArchivedSection(',
    'function MemoryTab('
  );
  return between(section, 'archivedAgents.map((a) => {', '      })}');
}

/** The whole restorable-dropdown row body, from map open to map close. */
function restorableRow() {
  const src = strip(read(FILES.strip));
  return between(src, 'restorableAgents.map((a: Agent) => {', '            })}');
}

test('useRestoreTeam exports one id-preserving respawn recipe + per-list restore wrappers', () => {
  const src = strip(read(FILES.restore));
  assert.match(src, /export async function respawnAgent\(/,
    'respawnAgent must be exported so the Archived list can reuse Restore Team\'s spawn recipe');
  assert.match(src, /export async function restoreArchivedAgent\(/,
    'restoreArchivedAgent must be exported for the Archived-section restore button');
  assert.match(src, /export async function restoreRestorableAgent\(/,
    'restoreRestorableAgent must be exported for the restorable-dropdown per-row restore button');
});

test('the shared respawn recipe keeps the original id and re-enters the saved worktree/session', () => {
  const src = strip(read(FILES.restore));
  const fn = between(src, 'export async function respawnAgent(', 'export async function restoreArchivedAgent(');
  assert.match(fn, /id: ptyId/,
    'respawn does not spawn with the ORIGINAL pty id — memory/inbox/registry cannot reattach');
  assert.match(fn, /ptyId = a\.ptyId \?\? `pty-\$\{a\.id\}`/,
    'the pty id fallback changed — the recipe must stay identical to Restore Team');
  assert.match(fn, /isolate: false/,
    'respawn must cd into the existing worktree (isolate:false), not create a conflicting one');
  assert.match(fn, /resume: true/,
    'respawn must resume the prior CLI session — a fresh session loses the agent\'s thread');
  assert.match(fn, /hive: \{ id: a\.id,/,
    'the hive id must stay the original agent id so memory/inbox/registry reattach');
  assert.match(fn, /gitIsRepo\(a\.worktreePath\)/,
    'respawn lost the worktree-gone fallback probe');
});

test('restoreArchivedAgent adds the spawned agent to the floor (unarchiving by id) without a frozen gate', () => {
  const src = strip(read(FILES.restore));
  const fn = between(src, 'export async function restoreArchivedAgent(', 'export function useRestoreTeam(');
  assert.match(fn, /await respawnAgent\(a, config\)/,
    'the archived restore does not reuse respawnAgent — a second spawn recipe would drift');
  assert.match(fn, /useStore\.getState\(\)\.addAgent\(outcome\.agent\)/,
    'a successful archived restore never calls addAgent — the agent cannot appear on the floor');
  assert.doesNotMatch(fn, /partitionFrozenAgents/,
    'restoreArchivedAgent filters frozen agents — the exact archived+FROZEN case would stay stranded');
});

test('floor cards pass a real unfreeze action for frozen agents, scoped to the frozen check', () => {
  const stripSrc = strip(read(FILES.strip));
  const cardCall = between(stripSrc, '<AgentCard', '/>');
  assert.match(cardCall, /onUnfreeze=\{\s*frozenIds\.has\(a\.id\)/,
    'AgentStrip does not pass onUnfreeze to the floor card only when the agent is frozen');
  assert.match(cardCall, /window\.cth\.controlAutoDelivery\(a\.id,\s*false\)/,
    'the floor-card unfreeze does not call the existing unfreeze IPC');
});

test('AgentCard accepts and renders an interactive Unfreeze control', () => {
  const src = strip(read(FILES.card));
  assert.match(src, /onUnfreeze\?: \(\) => void/,
    'AgentCard does not accept an onUnfreeze prop — the floor card cannot expose the action');
  assert.match(src, /\{badgeStatus === 'frozen' && onUnfreeze \?/,
    'the unfreeze control is not gated on the visible FROZEN state + onUnfreeze');
  assert.match(src, /role="button"[\s\S]*?onClick=\{\(e\) => \{ e\.stopPropagation\(\); onUnfreeze\(\); \}\}/,
    'the card-level unfreeze control is not an interactive stopPropagation control');
});

test('Archived list: every archived row gets a RESTORE action that unarchives AND respawns', () => {
  const src = strip(read(FILES.commandCenter));
  const section = between(src, 'function ArchivedSection(', 'function MemoryTab(');
  const row = archivedRow();
  assert.match(section, /config\?: HarnessConfig \| null/,
    'ArchivedSection does not receive config — it cannot know which archived agents are frozen');
  assert.match(section, /new Set\(config\?\.autoDeliveryPausedAgents \?\? \[\]\)/,
    'ArchivedSection does not compute the frozen set from config');
  assert.match(row, /restoreArchivedAgent\(a, config\)/,
    'the archived restore button does not call the shared restoreArchivedAgent helper');
  assert.match(row, /removeArchivedAgent\(a\.id\)/,
    'the destructive ✕ still removes the archived entry instead of restoring it');
});

test('Archived list: a frozen archived row shows Unfreeze AND still has the restore path (the BURD trap)', () => {
  const src = strip(read(FILES.commandCenter));
  const section = between(src, 'function ArchivedSection(', 'function MemoryTab(');
  const row = archivedRow();
  assert.match(row, /const isFrozen = frozenIds\.has\(a\.id\)/,
    'the archived row does not compute per-agent frozen state');
  assert.match(row, /isFrozen && \(/,
    'Unfreeze is not gated on the row being frozen');
  assert.match(row, /window\.cth\.controlAutoDelivery\(a\.id,\s*false\)/,
    'the archived-list Unfreeze does not use the existing IPC');
  // The restore button is NOT inside the `isFrozen &&` branch, so clicking it
  // respawns an archived+FROZEN agent too — that is the deliberate, explicit
  // user action the freeze semantics allow.
  const frozenBranchStart = row.indexOf('isFrozen && (');
  const frozenBranchEnd = row.indexOf(')}', frozenBranchStart) + 2;
  const frozenBranch = row.slice(frozenBranchStart, frozenBranchEnd);
  assert.doesNotMatch(frozenBranch, /restoreArchivedAgent/,
    'restore is inside the frozen-only branch — an archived+FROZEN agent could still never be restored');
});

test('the Unfreeze ACTION label says the verb, not the FROZEN status, in every locale', () => {
  for (const locale of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}.json`));
    const action = json.agentControl.unfreeze;
    const status = json.badge.frozen;
    assert.ok(typeof action === 'string' && action.trim() !== '', `${locale}: agentControl.unfreeze is missing`);
    assert.notEqual(action, status, `${locale}: the Unfreeze button still reads as the FROZEN status badge — it must say what it does`);
    assert.notEqual(action, json.agentControl.freeze, `${locale}: freeze and unfreeze labels are identical`);
  }
});

test('restorable dropdown: each row restores ONE agent via the shared helper, with busy + inline error', () => {
  const row = restorableRow();
  assert.match(row, /restoreRestorableAgent\(a, config\)/,
    'the per-row restore button does not call the shared restoreRestorableAgent helper');
  assert.match(row, /rowRestoreBusyId === a\.id/,
    'the per-row restore button has no busy state — a slow spawn looks like a dead click');
  assert.match(row, /rowRestoreErrors\[a\.id\]/,
    'the per-row restore button has no inline error line');
  assert.match(row, /removeRestorableAgent\(a\.id\)/,
    'the per-row dismiss ✕ is still wired to removeRestorableAgent');
  assert.match(row, /controlAutoDelivery\(a\.id,\s*false\)/,
    'the frozen-row Unfreeze control disappeared from the dropdown');
});

test('config is threaded to the Command Center from every mount point', () => {
  const app = strip(read(FILES.app));
  assert.match(app, /<AgentDetailPanel agent=\{agent\} config=\{config\} \/>/,
    'App does not pass config into AgentDetailPanel');
  const detail = strip(read(FILES.detail));
  assert.match(detail, /config\?: HarnessConfig \| null/,
    'AgentDetailPanel does not accept config');
  assert.match(detail, /<CommandCenterPanel agent=\{agent\} config=\{config\} \/>/,
    'AgentDetailPanel does not pass config into CommandCenterPanel');
  const fullscreen = strip(read(FILES.fullscreen));
  assert.match(fullscreen, /<CommandCenterPanel agent=\{agent\} fullscreen config=\{config\} \/>/,
    'FullscreenTerminal does not pass config into its CommandCenterPanel');
});
