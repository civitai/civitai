import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spokeLogout } from '../spoke-logout';

const HUB = 'https://auth.civitai.com';
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_BASE_URL = 'https://moderator.civitai.com';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function request(cookie?: string) {
  return new Request('https://moderator.civitai.com/logout', {
    headers: cookie ? { cookie } : {},
  });
}

const clears = (setCookies: string[], name: string, domain?: string) =>
  setCookies.some(
    (h) =>
      h.startsWith(`${name}=;`) &&
      /Max-Age=0/.test(h) &&
      (domain ? h.includes(`Domain=${domain}`) : !/Domain=/.test(h))
  );

describe('spokeLogout', () => {
  it('revokes the token and finishes through the hub, back to the spoke', async () => {
    const revoke = vi.fn(async () => {});
    const res = await spokeLogout(request('__Secure-civ-token=tok; other=1'), {
      hubBase: HUB,
      sessionTokenClient: { revoke },
    });
    expect(revoke).toHaveBeenCalledWith('tok');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `${HUB}/logout?returnUrl=${encodeURIComponent('https://moderator.civitai.com')}`
    );
  });

  it('expires the session and device cookies under every name and scope', async () => {
    const res = await spokeLogout(request(), {
      hubBase: HUB,
      sessionTokenClient: { revoke: vi.fn() },
    });
    const setCookies = res.headers.getSetCookie();
    for (const base of ['civ-token', 'civ-device']) {
      expect(clears(setCookies, `__Host-${base}`)).toBe(true);
      expect(clears(setCookies, `__Secure-${base}`)).toBe(true);
      expect(clears(setCookies, `__Secure-${base}`, 'civitai.com')).toBe(true);
      expect(clears(setCookies, base, 'civitai.com')).toBe(true);
    }
    // A `__Host-` cookie with a Domain is rejected by the browser, so that clear would be a no-op.
    expect(setCookies.some((h) => h.startsWith('__Host-') && /Domain=/.test(h))).toBe(false);
  });

  // A malformed %-escape in the cookie value used to throw out of decodeURIComponent, so the sign-out never
  // happened. Control: with the try/catch removed, this rejects with URIError.
  it('still signs out when the session cookie value is not valid URI encoding', async () => {
    const revoke = vi.fn(async () => {});
    const res = await spokeLogout(request('__Secure-civ-token=tok%E0%A4%A; other=1'), {
      hubBase: HUB,
      sessionTokenClient: { revoke },
    });
    expect(revoke).toHaveBeenCalledWith('tok%E0%A4%A');
    expect(res.status).toBe(302);
    expect(clears(res.headers.getSetCookie(), '__Secure-civ-token')).toBe(true);
  });

  it('skips the revoke when there is no session cookie', async () => {
    const revoke = vi.fn(async () => {});
    await spokeLogout(request(), { hubBase: HUB, sessionTokenClient: { revoke } });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('returns to the spoke without a hub', async () => {
    const res = await spokeLogout(request(), {
      hubBase: null,
      sessionTokenClient: { revoke: vi.fn() },
    });
    expect(res.headers.get('location')).toBe('https://moderator.civitai.com');
  });
});
