import { N8N_BROKER_TOKEN_ENV, isN8nProjectKey, resolveN8nProject, type McpConsentEntry } from '../shared/mcpCatalog';

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
  if (!isN8nProjectKey(project) || !deps.brokerRunning() || !deps.hasToken(project) || !resolveN8nProject(consent, project, agentId)) return undefined;
  return { url: `${deps.brokerUrl()}/n8n-mcp`, env: { [N8N_BROKER_TOKEN_ENV]: deps.grant(agentId, project) } };
}
