/**
 * t-068 — the harness must look for Claude transcripts under the SAME root Claude
 * Code itself uses: `$CLAUDE_CONFIG_DIR` when the app was launched with one, else
 * `~/.claude`.
 *
 * The dev build runs with `CLAUDE_CONFIG_DIR=~/.claude-magenio`, and ptyEnv passes
 * that variable through to every spawned agent. With the root hard-coded to
 * `~/.claude/projects`, the harness seeded a resume transcript into one tree while
 * `claude --resume` read the other, and the spawn died with
 *
 *   No conversation found with session ID: 0051a78b-4387-46c1-886d-403871ebfd33
 *
 * (hive/crashes/2026-09-22T16-03-06-195Z-pam-mtctnhm3.log).
 *
 * POSIX-only, like transcript-project-dir.test.cjs: `os.homedir()` reads $HOME here.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { projectDir, seedSessionTranscript, resolveSessionCwd } = loadTs('src/main/transcript.ts');

/** Claude Code's project key for a cwd: every non-alphanumeric becomes a dash. */
const key = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const SESSION = '0051a78b-4387-46c1-886d-403871ebfd33';

/** Run `fn` with $HOME and $CLAUDE_CONFIG_DIR redirected to throwaway dirs, so no
 *  case ever touches the real ~/.claude. `configured` undefined = the variable is
 *  UNSET (not empty), which is the "no CLAUDE_CONFIG_DIR" case. */
function withEnv(run, { configured } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-t68-'));
  const prevHome = process.env.HOME;
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  if (configured === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configured(home);
  try {
    return run(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Write a transcript at `<root>/projects/<projectKey>/<session>.jsonl`. */
function writeTranscript(root, projectKey, session, cwd) {
  const dir = path.join(root, 'projects', projectKey);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ cwd })}\n`, 'utf8');
  return file;
}

// ─── the unchanged case ──────────────────────────────────────────────────────

test('with no CLAUDE_CONFIG_DIR the root is still ~/.claude', () => {
  withEnv((home) => {
    assert.equal(projectDir('/w/app'), path.join(home, '.claude', 'projects', key('/w/app')));
  });
});

test('with no CLAUDE_CONFIG_DIR a session is still copied into ~/.claude (regression)', () => {
  withEnv((home) => {
    const root = path.join(home, '.claude');
    writeTranscript(root, key('/elsewhere'), SESSION, '/elsewhere');
    assert.equal(seedSessionTranscript('/w/app', SESSION), true);
    assert.ok(fs.existsSync(path.join(root, 'projects', key('/w/app'), `${SESSION}.jsonl`)));
  });
});

// ─── the configured case ─────────────────────────────────────────────────────

test('with CLAUDE_CONFIG_DIR the active root wins over ~/.claude', () => {
  withEnv((home) => {
    const configured = path.join(home, '.claude-magenio');
    writeTranscript(configured, key('/w/app'), SESSION, '/w/app');       // active root
    writeTranscript(path.join(home, '.claude'), key('/w/app'), SESSION, '/w/app'); // other root
    assert.equal(projectDir('/w/app'), path.join(configured, 'projects', key('/w/app')));
  }, { configured: (home) => path.join(home, '.claude-magenio') });
});

test('the seed target is the ACTIVE root, even when ~/.claude has the same project dir', () => {
  // The exact production shape: both roots hold the cwd's project dir, and the
  // session to resume lives in the ~/.claude one. Seeding next to the SOURCE (the
  // old behaviour) leaves `claude --resume` looking at an empty active root.
  withEnv((home) => {
    const configured = path.join(home, '.claude-magenio');
    const other = path.join(home, '.claude');
    writeTranscript(other, key('/w/app'), SESSION, '/w/app');
    writeTranscript(other, key('/w/app-alt'), 'other-session', '/w/app-alt');

    assert.equal(seedSessionTranscript('/w/app', SESSION), true);
    assert.ok(
      fs.existsSync(path.join(configured, 'projects', key('/w/app'), `${SESSION}.jsonl`)),
      'copied into the root the CLI actually reads'
    );
    assert.equal(
      fs.existsSync(path.join(configured, 'projects', key('/w/app-alt'), 'other-session.jsonl')),
      false,
      'and only the requested session was seeded'
    );
  }, { configured: (home) => path.join(home, '.claude-magenio') });
});

test('a session found anywhere under ~/.claude is still seeded, and vice versa', () => {
  withEnv((home) => {
    const configured = path.join(home, '.claude-magenio');
    // Source lives in the FALLBACK root, under an unrelated project dir.
    writeTranscript(path.join(home, '.claude'), key('/some/other/place'), SESSION, '/some/other/place');
    assert.equal(seedSessionTranscript('/w/app', SESSION), true);
    assert.ok(fs.existsSync(path.join(configured, 'projects', key('/w/app'), `${SESSION}.jsonl`)));
  }, { configured: (home) => path.join(home, '.claude-magenio') });
});

test('a session that exists nowhere still reports false, so the caller starts fresh', () => {
  withEnv(() => {
    assert.equal(seedSessionTranscript('/w/app', 'no-such-session'), false);
  }, { configured: (home) => path.join(home, '.claude-magenio') });
});

test('an already-seeded session is a no-op that reports true', () => {
  withEnv((home) => {
    const configured = path.join(home, '.claude-magenio');
    writeTranscript(configured, key('/w/app'), SESSION, '/w/app');
    assert.equal(seedSessionTranscript('/w/app', SESSION), true);
  }, { configured: (home) => path.join(home, '.claude-magenio') });
});

test('resolveSessionCwd searches both roots, not just the active one', () => {
  withEnv((home) => {
    writeTranscript(path.join(home, '.claude'), key('/legacy/place'), SESSION, '/legacy/place');
    assert.equal(resolveSessionCwd(SESSION), '/legacy/place');
  }, { configured: (home) => path.join(home, '.claude-magenio') });
});

test('resolveSessionCwd prefers the most recent match across roots', () => {
  withEnv((home) => {
    const configured = path.join(home, '.claude-magenio');
    const other = path.join(home, '.claude');
    writeTranscript(other, key('/old/place'), SESSION, '/old/place');
    const newer = writeTranscript(configured, key('/new/place'), SESSION, '/new/place');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(newer, future, future);
    assert.equal(resolveSessionCwd(SESSION), '/new/place');
  }, { configured: (home) => path.join(home, '.claude-magenio') });
});
