/** Write-only per-project bearer operations for catalog remotes. */
import { isN8nProjectKey, normalizeRemoteUrl, remoteSecretRef, type N8nTokenCheck } from '../shared/mcpCatalog';

export interface RemoteTokenDeps {
  setSecret: (ref: string, token: string) => { ok: boolean };
  deleteSecret: (ref: string) => boolean;
  hasSecret: (ref: string) => boolean;
  getSecret: (ref: string) => string | undefined;
  urlFor: (id: string, project: string) => string | undefined;
  checkToken: (url: string, token: string) => Promise<N8nTokenCheck>;
}

export function createRemoteTokenOps(deps: RemoteTokenDeps) {
  const ref = (id: string, project: string): string | undefined =>
    isN8nProjectKey(project) ? remoteSecretRef(id, project) : undefined;
  return {
    set(id: string, project: string, rawToken: string): { ok: boolean; error?: string } {
      const secretRef = ref(id, project);
      if (!secretRef) return { ok: false, error: 'invalid remote or project' };
      const token = String(rawToken ?? '').trim();
      if (!token) return { ok: true };
      try { return { ok: deps.setSecret(secretRef, token).ok }; }
      catch { return { ok: false }; }
    },
    clear(id: string, project: string): { ok: boolean } {
      const secretRef = ref(id, project);
      if (!secretRef) return { ok: false };
      try { return { ok: deps.deleteSecret(secretRef) }; }
      catch { return { ok: false }; }
    },
    has(id: string, project: string): boolean {
      const secretRef = ref(id, project);
      if (!secretRef) return false;
      try { return deps.hasSecret(secretRef); }
      catch { return false; }
    },
    async test(id: string, project: string): Promise<'missing' | N8nTokenCheck> {
      const secretRef = ref(id, project);
      if (!secretRef) return 'missing';
      try {
        const token = deps.getSecret(secretRef);
        if (!token) return 'missing';
        const url = normalizeRemoteUrl(id, deps.urlFor(id, project));
        if (!url) return 'unreachable';
        return await deps.checkToken(url, token);
      } catch { return 'unreachable'; }
    }
  };
}
