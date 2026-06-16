import { hubBaseUrl } from './hub';

// DEVICE-ACCOUNT CLIENT — the hub's per-device account set (multi-account switching; cutover doc E). Authorized
// by the BROWSER's forwarded cookies (civ-token + civ-device), not a service token: a same-origin proxy passes
// the request's Cookie header through. The hub is the sole authority (membership + freshness + active session).

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
  return {
    async list(cookie) {
      const base = hubBaseUrl();
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
      const base = hubBaseUrl();
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
      const base = hubBaseUrl();
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
