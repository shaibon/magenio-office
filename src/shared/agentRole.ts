/**
 * Durable agent role vs live status.
 *
 * Hive `registry.json` stores `role` (job / hire one-liner). The floor roster
 * stores the same string as `description`. Live run-state belongs on
 * `status` / `action` — never on role. Pause, idle, and Cursor "standby"
 * captions are status, not a job.
 */

const TRANSIENT_ROLE_RE = /^(on\s+)?standby$|^(idle|awaiting|paused|resumed|working|thinking|archived|starting up|reconnecting…?|running the floor|a fresh harness)$/i;

export function isDurableRole(text: string | undefined | null): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  return !TRANSIENT_ROLE_RE.test(value);
}

/**
 * Pick the job string that should survive a respawn or roster/registry sync.
 * A real hire role always beats a status-like caption. When both are durable,
 * `candidate` wins (the value the operator just set).
 */
export function preferredAgentRole(
  candidate: string | undefined | null,
  fallback: string | undefined | null,
  isGod = false
): string {
  const incoming = (candidate ?? '').trim();
  const existing = (fallback ?? '').trim();
  if (isDurableRole(incoming)) return incoming;
  if (isDurableRole(existing)) return existing;
  if (incoming) return incoming;
  if (existing) return existing;
  return isGod ? 'orchestrator (god)' : 'agent';
}

/** t-056: is this agent a PM (a "Pam")? Matched by keyword against the durable
 *  role/capabilities text, the same way `modelForRole` (config.ts) already picks
 *  cheap-model helpers — there is no structured role enum, `role` is free text
 *  set at hire. Never by agent id: an id changes across a restore, a role
 *  string survives it. god is excluded even if its text somehow matched. */
export function isPmRole(meta: { role?: string | null; capabilities?: string[] | null; isGod?: boolean } | undefined | null): boolean {
  if (!meta || meta.isGod) return false;
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  return /\b(pm|project manager)\b/.test(hay);
}

/** Role to send on spawn/restart. Omit a transient roster caption so the hive
 *  registry can keep the last real hire role. */
export function roleForHiveSpawn(agent: {
  description?: string;
  isGod?: boolean;
  isAssistant?: boolean;
}): string | undefined {
  if (agent.isGod) return preferredAgentRole(agent.description, 'orchestrator (god)', true);
  if (agent.isAssistant) {
    return preferredAgentRole(agent.description, "Michael's prep assistant");
  }
  const role = agent.description?.trim();
  return role && isDurableRole(role) ? role : undefined;
}
