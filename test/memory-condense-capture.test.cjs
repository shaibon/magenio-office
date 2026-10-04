'use strict';

// A hidden summarizer session writes its transcript into the Claude Code project
// dir keyed by its working directory, and the capture step used to pick the NEWEST
// file there. When the caller's directory also hosts a long-lived session, that
// session's transcript is the newest one, so the capture read its prose instead of
// the JSON the call had just produced — and every pass aborted.
//
// The capture is now pinned to the files the call itself created: a set sampled
// before the spawn. The first case below reproduces the ordering that used to lose
// the capture and fails if the set is not honoured.
//
// POSIX-only: projectDir() resolves against os.homedir(), which the fixture
// redirects via $HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { listTranscriptFiles, extractLastAssistantText } = loadTs('src/main/hiddenClaude.ts');
const { projectDir } = loadTs('src/main/transcript.ts');
const {
  verify, rebuild, pinnedLines, OVER_BUDGET_MIN_GAIN_BYTES
} = loadTs('src/main/reflect.ts');

/** Mirrors BUDGET_BYTES (128 KiB) — the boundary the over-budget rule pivots on. */
const BUDGET = 131_072;

// ─── transcript capture ───────────────────────────────────────────────────────

/** One transcript line carrying an assistant text block. */
function assistantLine(text) {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

const SUMMARY = JSON.stringify({ condensed: 'compacted summary', hoist: [] });

/** Set an exact mtime (ms) so "newest file" is decided by the fixture, not by
 *  write order. */
function setMtime(file, ms) {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

/** A throwaway home plus a cwd whose project dir the case populates. projectDir()
 *  reads $HOME at call time, so the redirection must happen before it is used. */
function withFixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-capture-'));
  const prevHome = process.env.HOME;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const cwd = path.join(home, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const project = projectDir(cwd);
    fs.mkdirSync(project, { recursive: true });
    return run({ home, cwd, project });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a newer foreign transcript is never mistaken for this call’s own', () => {
  withFixture(({ cwd, project }) => {
    const now = Date.now();
    // The other session sharing this working directory: still running, written
    // last, so it is the newest file in the directory.
    const live = path.join(project, 'live.jsonl');
    fs.writeFileSync(live, assistantLine('unrelated prose from another session'));
    setMtime(live, now);

    // Sampled before the spawn: the live file already exists.
    const before = listTranscriptFiles(cwd);

    // This call's own transcript, written afterwards but with an OLDER mtime.
    const hidden = path.join(project, 'hidden.jsonl');
    fs.writeFileSync(hidden, assistantLine(SUMMARY));
    setMtime(hidden, now - 30_000);

    const spawnedAt = now - 60_000;
    // Newest-wins reads the live session — the defect, pinned here as the reason
    // the pre-spawn set exists.
    assert.equal(extractLastAssistantText(cwd, spawnedAt), 'unrelated prose from another session');
    // Only files created after the sample are eligible, so the capture is the
    // hidden session's own output regardless of mtime ordering.
    assert.equal(extractLastAssistantText(cwd, spawnedAt, before), SUMMARY);
  });
});

test('no new transcript means no text — never a stranger’s', () => {
  withFixture(({ cwd, project }) => {
    const now = Date.now();
    const live = path.join(project, 'live.jsonl');
    fs.writeFileSync(live, assistantLine('unrelated prose from another session'));
    setMtime(live, now);
    const before = listTranscriptFiles(cwd);
    assert.equal(extractLastAssistantText(cwd, now - 60_000, before), null);
  });
});

test('listTranscriptFiles reports the jsonl names already present', () => {
  withFixture(({ cwd, project }) => {
    assert.deepEqual([...listTranscriptFiles(cwd)], []);
    fs.writeFileSync(path.join(project, 'a.jsonl'), assistantLine('x'));
    fs.writeFileSync(path.join(project, 'notes.txt'), 'not a transcript');
    fs.mkdirSync(path.join(project, 'b.jsonl'));   // a directory, not a file
    assert.deepEqual([...listTranscriptFiles(cwd)].sort(), ['a.jsonl']);
  });
});

// ─── the verify gate ─────────────────────────────────────────────────────────

/** A minimal 3-region file that passes every structural check in `verify`. */
function fixture() {
  const pinned = 'fact one\nfact two';
  const condensed = 'rolling summary';
  const keep = [{ heading: '## 2026-10-02 — note', body: 'the newest section' }];
  const lines = pinnedLines(pinned);
  return {
    rebuilt: rebuild('# Memory\n', lines, condensed, keep),
    oldPinnedLines: lines, mergedPinned: lines, condensed, keep
  };
}

function verdict(oldBytes, newBytes) {
  return verify({ ...fixture(), newBytes, oldBytes });
}

test('an over-budget file may shrink by an absolute gain, not only 5%', () => {
  const oldBytes = 200_000;                                   // over budget
  assert.deepEqual(verdict(oldBytes, oldBytes - OVER_BUDGET_MIN_GAIN_BYTES), { ok: true });
  assert.deepEqual(
    verdict(oldBytes, oldBytes - OVER_BUDGET_MIN_GAIN_BYTES + 1),
    { ok: false, reason: 'not-smaller' }
  );
});

test('crossing under the budget counts even when the gain is small', () => {
  assert.deepEqual(verdict(BUDGET + 1_000, BUDGET - 1_000), { ok: true });
});

test('under budget the flat 5% rule still applies', () => {
  assert.deepEqual(verdict(100_000, 94_000), { ok: true });            // 6%
  assert.deepEqual(verdict(100_000, 96_000), { ok: false, reason: 'not-smaller' }); // 4%
});
