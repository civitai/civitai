import { loadAuthEnv } from './env';

// DEVICE-ACCOUNT CLIENT — the consumer-side interface to the hub's per-device account set (multi-account
// switching; docs/main-app-auth-cutover.md, section E). Unlike the SessionClient (token → user, service-authed),
// these ops are authorized by the BROWSER's own cookies (civ-token + civ-device): a same-origin proxy forwards
// the request's `Cookie` header to the hub, so the spoke never hand-rolls the hub URL/contract.
//
//   list(cookie)            → GET    {iss}/api/auth/accounts        — display-only linked-account list
//   switch(cookie, userId)  → POST   {iss}/api/auth/switch          — authorize + mint a fresh civ-token
//   remove(cookie, userId)  → DELETE {iss}/api/auth/accounts        — drop one account from this device's set
//
// The hub is the sole authority (membership + freshness + an active session); the spoke is a thin forwarder.

/** A linked account on the browser's device set — display only (no credentials leave the hub). */
export interface DeviceAccount {
  userId: number;
  username?: string;
  image?: string;
  lastSwitchedAt: number;
  active: boolean;
}

export interface DeviceAccountClient {
  /** The browser's linked-account list. Forward the request's `Cookie` header. Empty if unauthorized/unreachable. */
  list(cookie: string): Promise<DeviceAccount[]>;
  /**
   * Device-level switch: the hub authorizes (active session + target in this device's set + fresh) and returns
   * a freshly minted civ-token for `userId`. Null when the hub declines (not linked / aged out / unreachable);
   * the caller sets the returned token as the session cookie.
   */
  switch(cookie: string, userId: number): Promise<{ token: string } | null>;
  /** Remove `userId` from this browser's device set. Returns whether the hub accepted it. */
  remove(cookie: string, userId: number): Promise<boolean>;
}

export function createDeviceAccountClient(): DeviceAccountClient {
  // The hub (token issuer). Returns null when unconfigured so the spoke degrades to "no linked accounts"
  // rather than throwing on a request path.
  const hubBase = (): string | null => {
    const baseUrl = loadAuthEnv().AUTH_JWT_ISSUER;
    return baseUrl ? baseUrl.replace(/\/+$/, '') : null;
  };

  return {
    async list(cookie) {
      const base = hubBase();
      if (!base) return [];
      try {
        const res = await fetch(`${base}/api/auth/accounts`, { headers: { cookie } });
        if (!res.ok) return [];
        const { accounts = [] } = (await res.json()) as { accounts?: DeviceAccount[] };
        return accounts;
      } catch {
        return [];
      }
    },
    async switch(cookie, userId) {
      const base = hubBase();
      if (!base) return null;
      try {
        const res = await fetch(`${base}/api/auth/switch`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        if (!res.ok) return null;
        const { token } = (await res.json()) as { token?: string };
        return token ? { token } : null;
      } catch {
        return null;
      }
    },
    async remove(cookie, userId) {
      const base = hubBase();
      if (!base) return false;
      try {
        const res = await fetch(`${base}/api/auth/accounts?userId=${userId}`, {
          method: 'DELETE',
          headers: { cookie },
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
