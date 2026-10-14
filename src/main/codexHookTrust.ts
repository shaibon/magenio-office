/**
 * Pre-trust the lifecycle hooks Munder writes into a Codex agent's config.toml.
 *
 * Codex only runs a hook whose content hash is recorded as trusted
 * (`[hooks.state."<key>"] trusted_hash = "sha256:…"`), and silently skips the rest.
 * The `--dangerously-bypass-hook-trust` flag we pass covers the TUI process only.
 * Since Codex Remote Control, the session (and so every hook) runs in a managed
 * app-server DAEMON started without that flag, so our hooks were "untrusted" there
 * and never ran: no status, no Stop→inbox drain.
 *
 * Rather than re-derive Codex's hash, ask Codex's own resolver (`hooks/list`) for
 * it and write it back as trust state. The state lives in the config file, so it
 * holds for the daemon, the TUI and `--no-daemon` alike.
 */
import { execFileSync } from 'node:child_process';

export interface ListedHook {
  key: string;
  command?: string;
  currentHash: string;
  trustStatus?: string;
  sourcePath?: string;
}

/** Entries of a `hooks/list` JSON-RPC reply, or [] for anything else. */
export function parseHooksList(line: string): ListedHook[] {
  try {
    const o = JSON.parse(line) as { result?: { data?: { hooks?: ListedHook[] }[] } };
    return (o.result?.data ?? []).flatMap((d) => d.hooks ?? []);
  } catch { return []; }
}

/** The `[hooks.state.…]` tables for exactly the hooks whose command IS the one we
 *  generated (string equality, never "contains": a user hook that merely mentions
 *  the shim path must not inherit trust). Nothing else is trusted; a user's own
 *  hooks seeded into the config keep their own state. */
export function hookTrustToml(hooks: ListedHook[], generatedCommand: string): string {
  return hooks
    .filter((h) => typeof h.key === 'string' && /^sha256:[0-9a-f]{64}$/.test(h.currentHash ?? '') && h.command === generatedCommand)
    .map((h) => `\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.currentHash)}\n`)
    .join('');
}

// Runs under the bundled node: drives `codex app-server` over stdio just long
// enough to get one hooks/list reply, then exits. No model request is made.
const DRIVER = `
const { spawn } = require('node:child_process');
const [bin, cwd] = process.argv.slice(1);
const p = spawn(bin, ['app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
const send = (o) => p.stdin.write(JSON.stringify(o) + '\\n');
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.includes('"id":2')) { process.stdout.write(line); p.kill(); process.exit(0); }
  }
});
p.on('exit', () => process.exit(1));
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'munder-hook-trust', version: '1' } } });
send({ method: 'initialized' });
send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
setTimeout(() => process.exit(1), 8000);
`;

/** Ask Codex which hooks `home` defines. Throws when codex cannot answer. */
export function listCodexHooks(codexBin: string, home: string, cwd: string, nodeBin: string, env: NodeJS.ProcessEnv): ListedHook[] {
  const out = execFileSync(nodeBin, ['-e', DRIVER, codexBin, cwd], {
    env: { ...env, CODEX_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 12_000, stdio: ['ignore', 'pipe', 'ignore']
  });
  return parseHooksList(out);
}

/** `[projects."<dir>"] trust_level = "trusted"` for each dir not already declared in
 *  `config`, so the codex TUI does not ask the Boss to trust an agent's folder on
 *  every spawn. Lives in the per-agent config.toml, so it holds for the TUI and the
 *  managed daemon alike, and only ever names the agent's own folders. A user-seeded
 *  config that already has the table is left alone (a duplicate table is a TOML
 *  error that would break the whole file). */
export function projectTrustToml(config: string, dirs: string[]): string {
  const seen = new Set<string>();
  let out = '';
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    const header = `[projects.${JSON.stringify(d)}]`;
    if (config.includes(header)) continue;
    out += `\n${header}\ntrust_level = "trusted"\n`;
  }
  return out;
}
