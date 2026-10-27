import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/shared/constants/generation.constants', () => ({
  generationServiceCookie: { name: 'civitai-generation' },
}));

const HUB = 'https://auth.civitai.com';

async function logout(host: string, env: { hub?: string } = { hub: HUB }) {
  if (env.hub) process.env.AUTH_JWT_ISSUER = env.hub;
  else delete process.env.AUTH_JWT_ISSUER;
  const { default: handler } = await import('~/pages/api/auth/logout');
  const res = {
    headers: {} as Record<string, string | string[]>,
    location: undefined as string | undefined,
    setHeader(name: string, value: string | string[]) {
      this.headers[name.toLowerCase()] = value;
    },
    redirect(_status: number, url: string) {
      this.location = url;
    },
  };
  await handler(
    {
      query: { callbackUrl: '/models' },
      cookies: {},
      headers: { host, 'x-forwarded-proto': 'https' },
    } as never,
    res as never
  );
  return { location: res.location, setCookies: res.headers['set-cookie'] as string[] };
}

// The browser's view of the hub host's jar: `domain` undefined = host-only on auth.civitai.com.
type Entry = { name: string; domain?: string };

/** Apply Set-Cookie headers a response from `fromHost` sent, to the jar the hub host holds. */
function applyToHubJar(jar: Entry[], fromHost: string, setCookies: string[]): Entry[] {
  return jar.filter((e) => {
    return !setCookies.some((h) => {
      const name = h.slice(0, h.indexOf('='));
      if (name !== e.name || !/Max-Age=0/i.test(h)) return false;
      const domain = /;\s*Domain=([^;]+)/i.exec(h)?.[1]?.replace(/^\./, '');
      // A host-only clear reaches only the host that sent it; a Domain clear reaches that Domain's cookies.
      return domain ? e.domain === domain : !e.domain && fromHost === 'auth.civitai.com';
    });
  });
}

describe('main-app logout finishes through the hub', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('sends a civitai.com logout through the hub, returning to the page it came from', async () => {
    const { location } = await logout('civitai.com');
    expect(location).toBe(
      `${HUB}/logout?returnUrl=${encodeURIComponent('https://civitai.com/models')}`
    );
  });

  it('still sends a civitai.red logout through the hub', async () => {
    const { location } = await logout('civitai.red');
    expect(location).toBe(
      `${HUB}/logout?returnUrl=${encodeURIComponent('https://civitai.red/models')}`
    );
  });

  it('returns locally when no hub is configured', async () => {
    const { location } = await logout('civitai.com', {});
    expect(location).toBe('/models');
  });

  // Why the bounce is needed: main's own clears cannot reach the hub's host-only cookies.
  it("leaves the hub's host-only device cookie in place on its own", async () => {
    const { setCookies } = await logout('civitai.com');
    const hubJar = applyToHubJar(
      [
        { name: '__Host-civ-device' },
        { name: '__Secure-civ-token', domain: 'civitai.com' },
        { name: '__Secure-civ-device', domain: 'civitai.com' },
      ],
      'civitai.com',
      setCookies
    );
    expect(hubJar).toEqual([{ name: '__Host-civ-device' }]);
  });
});
