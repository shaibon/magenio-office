import { isN8nProjectKey, remoteBrokerEnv, remoteBrokerRoute, resolveRemoteProject, type McpConsentEntry } from '../shared/mcpCatalog';

export interface N8nGrantDeps {
  brokerRunning: () => boolean;
  brokerUrl: () => string;
  hasToken: (project: string) => boolean;
  grant: (agentId: string, project: string) => string;
}

/** Single source of truth for the n8n MCP at spawn: the mount URL and the capability
 *  env travel together. Undefined = mount nothing (the server is only written to
 *  mcp.json when its token env is minted, so a mounted server can never 401). */
export function n8nSpawnGrant(
  deps: N8nGrantDeps,
  consent: McpConsentEntry | undefined,
  project: string | undefined,
  agentId: string
): { url: string; env: Record<string, string> } | undefined {
  return remoteSpawnGrant('n8n', deps, consent, project, agentId);
}

export function remoteSpawnGrant(
  id: string,
  deps: N8nGrantDeps,
  consent: McpConsentEntry | undefined,
  project: string | undefined,
  agentId: string
): { url: string; env: Record<string, string> } | undefined {
  const env = remoteBrokerEnv(id);
  const route = remoteBrokerRoute(id);
  if (!env || !route || !isN8nProjectKey(project) || !deps.brokerRunning()
    || !deps.hasToken(project) || !resolveRemoteProject(id, consent, project, agentId)) return undefined;
  return { url: `${deps.brokerUrl()}${route}`, env: { [env]: deps.grant(agentId, project) } };
}
