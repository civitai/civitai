import { parseCookieHeader, readDeviceId, readSessionToken, siteCookieHeader } from './cookies';
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
  /**
   * The browser's linked-account list. Forward the request's `Cookie` and `Host` headers (`host` null in an app
   * that serves one site). Empty if unauthorized/unreachable.
   */
  list(cookie: string, host: string | null | undefined): Promise<DeviceAccount[]>;
  /**
   * Device-level switch: the hub authorizes (active session + target in this device's set + fresh) and returns
   * a freshly minted civ-token for `userId`. Null when the hub declines (not linked / aged out / unreachable);
   * the caller sets the returned token as the session cookie.
   */
  switch(
    cookie: string,
    userId: number,
    host: string | null | undefined
  ): Promise<{ token: string } | null>;
  /** Remove `userId` from this browser's device set. Returns whether the hub accepted it. */
  remove(cookie: string, userId: number, host: string | null | undefined): Promise<boolean>;
}

// The session in a forwarded Cookie header, and the header itself as forwarded (a host-only site's own cookies).
const sessionOf = (
  rawCookie: string,
  host: string | null | undefined
): { session: SessionRef; cookie: string } => {
  const cookie = siteCookieHeader(rawCookie, host);
  const jar = parseCookieHeader(cookie);
  return {
    session: {
      token: readSessionToken(jar, { host })?.value,
      deviceId: readDeviceId(jar, { host })?.value,
    },
    cookie,
  };
};

export function createDeviceAccountClient(): DeviceAccountClient {
  return {
    async list(rawCookie, host) {
      try {
        const { session, cookie } = sessionOf(rawCookie, host);
        const { headers, body, internal } = sessionCall(session, { cookie });
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
    async switch(rawCookie, userId, host) {
      try {
        const { session, cookie } = sessionOf(rawCookie, host);
        const { headers, body } = sessionCall(session, { cookie }, { userId });
        const res = await hubFetch('/api/auth/switch', { method: 'POST', headers, body });
        if (!res.ok) return null;
        const { token } = (await res.json()) as { token?: string };
        return token ? { token } : null;
      } catch {
        return null;
      }
    },
    async remove(rawCookie, userId, host) {
      try {
        const { session, cookie } = sessionOf(rawCookie, host);
        const { headers, body } = sessionCall(session, { cookie });
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
