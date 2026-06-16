// BROWSER auth client (`@civitai/auth/client`) — the calls a spoke makes from the BROWSER to its own same-origin
// proxy routes (which forward to the hub via the server clients). The ONE place client code talks to auth, so
// components never hand-roll a fetch. BROWSER-SAFE (no jose/redis/env) and pure (no navigation — callers reload).

/** A linked account on the browser's device set — display only (mirrors the hub's `/api/auth/accounts` row). */
export interface DeviceAccountSummary {
  userId: number;
  username?: string;
  image?: string;
  lastSwitchedAt: number;
  active: boolean;
}

// Same-origin spoke proxy routes (the contract between this client and the app's proxy handlers).
const ROUTES = {
  accounts: '/api/auth/accounts',
  switch: '/api/auth/switch',
  impersonate: '/api/auth/impersonate',
} as const;

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export const authClient = {
  /** The browser's device account set (display only). Returns [] on any failure (unauthenticated / unreachable). */
  async listAccounts(): Promise<DeviceAccountSummary[]> {
    const res = await fetch(ROUTES.accounts);
    if (!res.ok) return [];
    const { accounts = [] } = (await res.json()) as { accounts?: DeviceAccountSummary[] };
    return accounts;
  },

  /** Seamless device switch. `true` when the hub authorized it; `false` ⇒ the caller falls back to a re-login. */
  async switchAccount(userId: number): Promise<boolean> {
    const res = await fetch(ROUTES.switch, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    return res.ok;
  },

  /** Remove an account from this browser's device set. */
  async removeAccount(userId: number): Promise<boolean> {
    const res = await fetch(`${ROUTES.accounts}?userId=${userId}`, { method: 'DELETE' });
    return res.ok;
  },

  /** Moderator impersonation — start acting as `userId`. Throws with the proxy's message on failure. */
  async impersonate(userId: number): Promise<void> {
    const res = await fetch(ROUTES.impersonate, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not impersonate'));
  },

  /** Stop impersonating — the hub reads `impersonatedBy` and re-mints the moderator's session. */
  async exitImpersonation(): Promise<void> {
    const res = await fetch(ROUTES.impersonate, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not exit impersonation'));
  },
};
