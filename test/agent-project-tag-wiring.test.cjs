'use strict';

// Wiring checks for the project-tag feature: every component that shows an
// agent's bare name in a flat context (Command Center pickers, restore
// toasts, detail headers) must go through the SHARED
// src/renderer/src/hooks/useResolvedRepoNames.ts — not redefine its own copy
// of the git-resolution logic, which is exactly the duplication this
// extraction was meant to end.
//
// These are source-scan tests (not mounted-component tests) for the same
// reason settings-one-save.test.cjs is: the touched files are JSX with a
// wide import graph and no existing render-test harness in this repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const FILES = {
  fullscreen: 'src/renderer/src/components/FullscreenTerminal.tsx',
  detail: 'src/renderer/src/components/AgentDetailPanel.tsx',
  commandCenter: 'src/renderer/src/components/CommandCenterPanel.tsx',
  strip: 'src/renderer/src/components/AgentStrip.tsx'
};

test('the shared hook file exists and exports the pure functions + the hook', () => {
  const src = read('src/renderer/src/hooks/useResolvedRepoNames.ts');
  for (const name of ['basename', 'repoKeyOf', 'repoLabelOf', 'useResolvedRepoNames', 'projectTag', 'projectTagCompact']) {
    assert.match(src, new RegExp(`export function ${name}\\(`), `${name} is not exported`);
  }
});

test('FullscreenTerminal no longer defines its own copy — it imports the shared hook', () => {
  const src = read(FILES.fullscreen);
  assert.match(src, /from '@\/hooks\/useResolvedRepoNames'/, 'must import from the shared hook file');
  assert.doesNotMatch(src, /^const repoRootByCwd = new Map/m,
    'the private cache must be gone — a second copy would resolve git roots twice and disagree with the shared one');
  assert.doesNotMatch(src, /^function useResolvedRepoNames\(/m, 'must not redefine the hook locally');
});

for (const [key, file] of Object.entries(FILES)) {
  test(`${key} imports from the shared hook file, not a local reimplementation`, () => {
    const src = read(file);
    assert.match(src, /from '@\/hooks\/useResolvedRepoNames'/, `${file} does not import the shared hook`);
  });
}

test('every consumer besides FullscreenTerminal calls useResolvedRepoNames itself, rather than assuming another mount already ran it', () => {
  // FullscreenTerminal's own top-level call was already there before this
  // feature; every NEW consumer added by it must call the hook too, since a
  // component can mount (e.g. a fullscreen Header, or AgentDetailPanel) in a
  // tree that never rendered FullscreenTerminal's own roster.
  for (const file of [FILES.detail, FILES.commandCenter, FILES.strip]) {
    const src = read(file);
    assert.match(src, /useResolvedRepoNames\(/, `${file} never calls useResolvedRepoNames`);
  }
});

test('projectTag is used everywhere a bare agent name is shown in a flat/ambiguous context', () => {
  const cc = read(FILES.commandCenter);
  const ccHits = cc.match(/projectTag\(/g) ?? [];
  assert.ok(ccHits.length >= 3, `expected the dispatch option, roster row, and memory-file option to all use projectTag — found ${ccHits.length} uses`);

  const strip = read(FILES.strip);
  const stripHits = strip.match(/projectTag\(/g) ?? [];
  assert.ok(stripHits.length >= 4, `expected the restorable-agents name plus its title/aria-label toasts to use projectTag — found ${stripHits.length} uses`);

  const fullscreen = read(FILES.fullscreen);
  const fullscreenHits = fullscreen.match(/projectTag\(/g) ?? [];
  assert.ok(fullscreenHits.length >= 4, `expected the fullscreen header AND the restorable chips at the bottom of the rail to use projectTag — found ${fullscreenHits.length} uses`);
});

test('FullscreenTerminal resolves restorable agents too, not just the live roster', () => {
  const src = read(FILES.fullscreen);
  assert.match(src, /useResolvedRepoNames\(restorableAgents\)/,
    'the fullscreen restore chips never resolve the saved cwds of last session\'s (archived) agents — labels cannot come from repoRootByCwd');
});

test('dense restore lists show the compact tag visibly and keep the full tag in titles', () => {
  const strip = read(FILES.strip);
  const fullscreen = read(FILES.fullscreen);
  // Full disambiguation is preserved in titles/aria (title strings use projectTag).
  assert.match(strip, /title=\{t\('agentStrip\.restorable', \{ name: `\$\{a\.name\}\$\{projectTag\(a\)\}` \}\)\}/,
    'AgentStrip row title lost the full project tag');
  assert.match(fullscreen, /title=\{`\$\{a\.name\}\$\{projectTag\(a\)\} — restorable from last session`\}/,
    'FullscreenTerminal chip title lost the full project tag');
  // The visible row/chip text uses the compact variant, so a Jira-bound repo
  // does not show ` - KEY · repoLabel` twice.
  assert.match(strip, /\{a\.name\}\{projectTagCompact\(a\)\}/,
    'AgentStrip visible label does not use projectTagCompact');
  assert.match(fullscreen, /\{a\.name\}\{projectTagCompact\(a\)\}/,
    'FullscreenTerminal visible chip text does not use projectTagCompact');
});

test('AgentStrip restore rows actually truncate: minWidth:0 on the ellipsis span + a menu width cap', () => {
  const src = read(FILES.strip);
  assert.match(src, /minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'/,
    'the ellipsis label span still lacks minWidth:0 — flex min-width:auto disables ellipsis');
  assert.match(src, /maxWidth: 'min\(420px, calc\(100vw - 24px\)\)'/,
    'the restore menu has no maxWidth and can grow off-screen with long labels');
});

test('FullscreenTerminal restore chips are single-line, clipped, and bounded', () => {
  const src = read(FILES.fullscreen);
  const chipIdx = src.lastIndexOf('restorableAgents.map(');
  assert.ok(chipIdx >= 0, 'restorableAgents.map( not found in FullscreenTerminal');
  const block = src.slice(chipIdx, chipIdx + 1200);
  assert.match(block, /minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'/,
    'the chip label span still lacks minWidth:0/nowrap/ellipsis');
  assert.match(src, /maxHeight: '32vh', overflowY: 'auto', alignContent: 'flex-start'/,
    'the restore chip area is not height-capped, so 23 entries can eat the whole rail');
});

test('CommandCenter archived section resolves archived agents and tags their names', () => {
  const src = read(FILES.commandCenter);
  assert.match(src, /useResolvedRepoNames\(archivedAgents\)/,
    'the archived flat list never resolves archived agents\' saved cwds');
  const archivedIdx = src.indexOf('archivedAgents.map(');
  assert.ok(archivedIdx >= 0, 'archivedAgents.map( not found in CommandCenterPanel');
  const block = src.slice(archivedIdx, archivedIdx + 1200);
  assert.match(block, /projectTag\(a\)/,
    'the archived list still renders a bare a.name — same-named archived agents stay ambiguous');
});

test('the fullscreen terminal header (the one spot with no other project context) shows the tag visibly', () => {
  const src = read(FILES.fullscreen);
  const i = src.indexOf('function Header(');
  assert.ok(i > 0, 'Header is gone');
  const body = src.slice(i, src.indexOf('\n}', src.lastIndexOf('return (', src.indexOf('\n}', i + 2000))));
  assert.match(src.slice(i), /agent\.name\.toUpperCase\(\)\}\{projectTag\(agent\)\.toUpperCase\(\)\}/,
    'the header title must append the visible project tag, not just carry it in an aria-label');
});

test('AgentDetailPanel and the fullscreen roster row read repoLabelOf, not the stale static agent.project', () => {
  for (const file of [FILES.detail, FILES.fullscreen]) {
    const src = read(file);
    assert.doesNotMatch(src, /\{agent\.project\}/,
      `${file} still displays the static agent.project directly — should read repoLabelOf(agent) instead`);
  }
});

test('the floor card forwards its nameTag into the inline name editor (regression: AgentNameEditor swallowed the tag)', () => {
  const card = read('src/renderer/src/components/AgentCard.tsx');
  assert.match(card, /<AgentNameEditor[\s\S]{0,300}?tag=\{nameTag && !isGod \? nameTag : undefined\}/,
    'AgentCard must pass the resolved name tag into AgentNameEditor — otherwise the inline rename editor renders a bare name and the t-033 tag never appears on floor cards');
  const editor = read('src/renderer/src/components/AgentNameEditor.tsx');
  assert.match(editor, /tag\?: string/,
    'AgentNameEditor does not accept a tag prop, so the floor card has nowhere to put the name tag');
});
