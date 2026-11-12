# Codex sandbox: per-agent overrides

Codex agents run in auto mode with the OS sandbox `-a never -s workspace-write`: writes are confined to the working directory plus the `--add-dir` roots, and outbound network is **off**. The global `codexSandbox` block in `config.json` can relax that for every Codex agent at once. `codexSandbox.perAgent` relaxes it for **one agent only**.

## Why

Typical case: the orchestrator (`god`) runs on Codex and has to reach Slack and the git host, while workers and the other floor agents should stay offline. Before this change the only option was the global `networkAccess` switch. The per-agent `config.toml` cannot be edited by hand, because it is rewritten on every spawn (`installCodexHooks` → `writeFresh`).

Network reaches Codex as a spawn argument (`-c sandbox_workspace_write.network_access=true`), not through `config.toml`. The override is applied at that point.

## Configuration

```json
"codexSandbox": {
  "networkAccess": false,
  "extraWritableDirs": [],
  "perAgent": {
    "god": { "networkAccess": true }
  }
}
```

| Field | Effect |
|---|---|
| key | The **hive agent id** as written in `registry.json` (`god` for the orchestrator, `<name>-<suffix>` for hired agents). Exact match. |
| `networkAccess` | Replaces the global value for that agent, either `true` or `false`. |
| `extraWritableDirs` | Added to the global list for that agent. |

Rules:

- **Keyed by id, never by display name.** A spawn-request may choose any `name`, but a worker id is always `worker-<reqId>`.
- **Ephemeral workers (`worker-*`) never receive an override**, even when a key matches.
- **`dangerFullAccess` cannot be set per agent.** It stays a global, visible choice.
- Missing map, unknown id or invalid values: the global block applies unchanged, so the default behaviour is untouched.
- The Settings panel edits only the global fields and keeps `perAgent` when it saves. The map is edited in `config.json` while the app is **closed**, because the app rewrites the file.

## Verifying

From a terminal on the host, not from inside an agent: inside the Codex sandbox `ps` fails with EPERM.

```bash
ps -axo pid,args | grep '[c]odex ' | grep -c 'network_access=true'   # agents with network
```

From the agent that has the override, `git ls-remote <remote> HEAD` should answer. From any other Codex agent, `curl -sI https://example.com` should fail with a DNS error (exit 6).

## Code

- `src/shared/codexSandbox.ts`: `codexSandboxForAgent(cfg, agentId)` merges the global block with the agent's entry (pure function, unit-tested).
- `src/main/index.ts`: applies it at spawn with the hive id (`hiveMeta.id`). The result flows unchanged through `hive.ts` → `codexSandboxArgs`.
- `src/renderer/src/components/SettingsModal.tsx`: preserves `perAgent` when the panel saves.
- Tests: `test/codex-sandbox.test.cjs`.
