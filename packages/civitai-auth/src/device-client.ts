import { parseCookieHeader, readDeviceId, readSessionToken } from './cookies';
import { hubFetch, sessionCall, type SessionRef } from './hub';

// DEVICE-ACCOUNT CLIENT — the hub's per-device account set (multi-account switching; cutover doc E). Callers
// pass the browser's Cookie header; the session and device id in it reach the hub through `sessionCall`. The
// hub is the sole authority (membership + freshness + active session).

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

const sessionOf = (cookie: string): SessionRef => {
  const jar = parseCookieHeader(cookie);
  return { token: readSessionToken(jar)?.value, deviceId: readDeviceId(jar)?.value };
};

export function createDeviceAccountClient(): DeviceAccountClient {
  return {
    async list(cookie) {
      try {
        const { headers, body, internal } = sessionCall(sessionOf(cookie), { cookie });
        // A GET has no body, so the internal shape lists by POST.
        const res = await hubFetch('/api/auth/accounts', {
          method: internal ? 'POST' : 'GET',
          headers,
          body,
        });
        if (!res.ok) return [];
        const { accounts = [] } = (await res.json()) as { accounts?: DeviceAccount[] };
        return accounts;
      } catch {
        return [];
      }
    },
    async switch(cookie, userId) {
      try {
        const { headers, body } = sessionCall(sessionOf(cookie), { cookie }, { userId });
        const res = await hubFetch('/api/auth/switch', { method: 'POST', headers, body });
        if (!res.ok) return null;
        const { token } = (await res.json()) as { token?: string };
        return token ? { token } : null;
      } catch {
        return null;
      }
    },
    async remove(cookie, userId) {
      try {
        const { headers, body } = sessionCall(sessionOf(cookie), { cookie });
        const res = await hubFetch(`/api/auth/accounts?userId=${userId}`, {
          method: 'DELETE',
          headers,
          body,
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
