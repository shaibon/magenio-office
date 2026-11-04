/**
 * Which broker capability a spawned agent gets. Pure, so restore/wake is testable.
 *
 * The role ledger is keyed by the HIVE agent id (`hive.id`). The pty id (`opts.id`)
 * differs from it on a restore, a manual restart and a hibernation wake, so the
 * lookup MUST use the hive id: with the pty id a PM silently got no token.
 */
export interface BrokerGrantPlan { agentId: string; readOnly: boolean; pmJira: boolean }

export function brokerGrantPlan(
  hive: { id?: string; isGod?: boolean } | undefined,
  ptyId: string,
  isPrivilegedPm: (agentId: string) => boolean
): BrokerGrantPlan | null {
  const agentId = hive?.id || ptyId;
  const isGod = !!hive?.isGod;
  if (isGod) return { agentId, readOnly: false, pmJira: false };
  if (!isPrivilegedPm(agentId)) return null;
  return { agentId, readOnly: true, pmJira: true };
}
