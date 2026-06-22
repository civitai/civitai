// BROWSER auth client (`@civitai/auth/client`) — STRICT hub fetches from a SAME-SITE spoke (e.g.
// moderator.civitai.com → auth.civitai.com). It calls the hub directly with `credentials: 'include'`, so the
// hub reads the spoke's cookies and sets the new one. Construct it with the hub's absolute base URL
// (e.g. NEXT_PUBLIC_AUTH_HUB_URL).
//
// NB: a CROSS-site spoke (civitai.red) can't use this — the browser won't send its cookies cross-site. Those
// apps (including the main app, which also deploys as .red) call their own same-origin /api/auth/* proxies
// instead. Browser-safe (no jose/redis/env); pure (no navigation — callers reload).

// Browser-safe re-exports of the pure contracts (hub login-URL + shared constants) — so client components import
// these from `@civitai/auth/client` and never pull the main entry's server-only graph (session-registry →
// @civitai/redis → node:net) into the browser bundle.
export { hubLoginUrl, type HubLoginUrlOptions } from './providers';
export * from './constants';

/** A linked account on the browser's device set — display only (mirrors the hub's `/api/auth/accounts` row). */
export interface DeviceAccountSummary {
  userId: number;
  username?: string;
  image?: string;
  lastSwitchedAt: number;
  active: boolean;
}

export interface AuthBrowserClient {
  listAccounts(): Promise<DeviceAccountSummary[]>;
  switchAccount(userId: number): Promise<boolean>;
  removeAccount(userId: number): Promise<boolean>;
  impersonate(userId: number): Promise<void>;
  exitImpersonation(): Promise<void>;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export function createAuthBrowserClient(hubBase: string): AuthBrowserClient {
  const base = hubBase.replace(/\/+$/, '');
  // credentials:'include' so the SAME-SITE spoke's cookies ride along + the hub's Set-Cookie is accepted.
  const hub = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, { credentials: 'include', ...init });

  return {
    async listAccounts() {
      const res = await hub('/api/auth/accounts');
      if (!res.ok) return [];
      const { accounts = [] } = (await res.json()) as { accounts?: DeviceAccountSummary[] };
      return accounts;
    },
    async switchAccount(userId) {
      const res = await hub('/api/auth/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      return res.ok;
    },
    async removeAccount(userId) {
      const res = await hub(`/api/auth/accounts?userId=${userId}`, { method: 'DELETE' });
      return res.ok;
    },
    async impersonate(userId) {
      const res = await hub('/api/auth/impersonate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, 'Could not impersonate'));
    },
    async exitImpersonation() {
      // POST /api/auth/impersonate/exit — the hub serves exit at its own route (the /impersonate route is
      // POST-only). Must match createImpersonationClient.exit() so the same-site browser path and the
      // cross-site proxy path hit ONE hub contract.
      const res = await hub('/api/auth/impersonate/exit', { method: 'POST' });
      if (!res.ok) throw new Error(await errorMessage(res, 'Could not exit impersonation'));
    },
  };
}
