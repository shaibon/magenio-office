/** DeepCode session discovery (t-286).
 *
 *  DeepCode's notify hook hands over no session id (only DURATION, STATUS, FAIL_REASON, BODY, TITLE),
 *  so the hive never learned one and hibernation held every deepcode agent at 'no-session'. But the CLI
 *  keeps each thread as `<home>/.deepcode/projects/<project code>/<session id>.jsonl` and resumes it
 *  with `deepcode --resume <id>`; the newest file in an agent's own project dir is the thread it is
 *  running. The project code mirrors the CLI's getProjectCode (legacy: path separators → '-', colons
 *  dropped; over 64 chars: sanitized basename prefix + sha256 of the resolved root). */
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const MAX_PROJECT_CODE_LENGTH = 64;
const HASH_LENGTH = 16;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function deepcodeProjectCode(projectRoot: string, platform: string = process.platform): string {
  const legacy = projectRoot.replace(/[\\/]/g, '-').replace(/:/g, '');
  if (legacy.length <= MAX_PROJECT_CODE_LENGTH) return legacy;
  const root = resolve(projectRoot);
  const hash = createHash('sha256').update(platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, HASH_LENGTH);
  const prefix = basename(root).replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_PROJECT_CODE_LENGTH - HASH_LENGTH - 1).replace(/[-.]+$/g, '') || 'project';
  return `${prefix}-${hash}`;
}

/** The newest session id for a working directory, or undefined when it has no thread yet. */
export function latestDeepcodeSession(cwd: string, home: string): string | undefined {
  const roots = new Set<string>([cwd]);
  try { roots.add(realpathSync(cwd)); } catch { /* the folder may be gone */ }
  let best: { id: string; at: number } | undefined;
  for (const root of roots) {
    const dir = join(home, '.deepcode', 'projects', deepcodeProjectCode(root));
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const m = SESSION_FILE.exec(n);
      if (!m) continue;
      try {
        const at = statSync(join(dir, n)).mtimeMs;
        if (!best || at > best.at) best = { id: m[1], at };
      } catch { /* vanished */ }
    }
  }
  return best?.id;
}
