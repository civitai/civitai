import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildLogoutCookies } from '~/pages/api/auth/logout';
import { clearAllSessionCookies, setSessionCookie } from '../civ-cookie';

vi.mock('~/shared/constants/generation.constants', () => ({
  generationServiceCookie: { name: 'civitai-generation' },
}));

// civitai.com's exact Set-Cookie output. Listing another site in AUTH_SESSION_COOKIE_MODE_BY_SITE must not change a
// byte of it. The full lists are pinned on purpose: change them only for a deliberate change to civitai.com's cookies.

const NOW = 2_000_000_000;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ sub: '1', exp: NOW + 3600 })}.sig`;
const JAR = {
  '__Host-civ-token': 'h',
  '__Host-civ-device': 'hd',
  '__Secure-civ-token': 's',
  '__Secure-civ-device': 'sd',
};

type Res = { getHeader: () => string[]; setHeader: (n: string, v: string | string[]) => void };
function written(write: (res: Res) => void) {
  let store: string[] = [];
  write({ getHeader: () => store, setHeader: (_n, v) => (store = ([] as string[]).concat(v)) });
  return store;
}

const outputs = () => ({
  signIn: written((res) =>
    setSessionCookie(res, TOKEN, { host: 'civitai.com', deviceCookie: 'D', requestCookies: JAR })
  ),
  signInSubdomain: written((res) =>
    setSessionCookie(res, TOKEN, {
      host: 'www.civitai.com',
      deviceCookie: 'D',
      requestCookies: JAR,
    })
  ),
  rollHostSlot: written((res) =>
    setSessionCookie(res, TOKEN, {
      host: 'civitai.com',
      deviceCookie: 'D',
      slot: 'host',
      requestCookies: JAR,
    })
  ),
  loopReset: clearAllSessionCookies('civitai.com'),
  signOut: buildLogoutCookies('civitai.com'),
});

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.AUTH_SESSION_COOKIE_MODE;
  delete process.env.AUTH_LEGACY_READ;
  delete process.env.NEXTAUTH_COOKIE_DOMAIN;
  delete process.env.AUTH_SESSION_COOKIE_MODE_BY_SITE;
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

it('civitai.com writes the same Set-Cookie headers whether or not civitai.red is listed', () => {
  const unlisted = outputs();
  process.env.AUTH_SESSION_COOKIE_MODE_BY_SITE = 'civitai.red:host';
  expect(outputs()).toEqual(unlisted);
  expect(unlisted).toMatchInlineSnapshot(`
    {
      "loopReset": [
        "civ-token=; Path=/; Max-Age=0; SameSite=Lax",
        "civ-token=; Path=/; Max-Age=0; SameSite=Lax; Domain=civitai.com",
        "__Secure-civ-token=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "__Secure-civ-token=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.com",
        "__Host-civ-token=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "__Host-civ-device=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "civ_postlogin=; Path=/; Max-Age=0; SameSite=Lax",
        "civ_login_retry=; Path=/; Max-Age=0; SameSite=Lax",
        "civ_pl_retry=; Path=/; Max-Age=0; SameSite=Lax",
      ],
      "rollHostSlot": [
        "__Host-civ-token=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIiwiZXhwIjoyMDAwMDAzNjAwfQ.sig; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=3600",
        "__Host-civ-device=D; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000",
        "__Secure-civ-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
        "__Secure-civ-device=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
      ],
      "signIn": [
        "__Secure-civ-token=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIiwiZXhwIjoyMDAwMDAzNjAwfQ.sig; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=civitai.com; Max-Age=3600",
        "__Secure-civ-device=D; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=civitai.com; Max-Age=2592000",
        "__Host-civ-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
        "__Host-civ-device=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
      ],
      "signInSubdomain": [
        "__Secure-civ-token=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIiwiZXhwIjoyMDAwMDAzNjAwfQ.sig; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=civitai.com; Max-Age=3600",
        "__Secure-civ-device=D; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=civitai.com; Max-Age=2592000",
        "__Host-civ-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
        "__Host-civ-device=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
      ],
      "signOut": [
        "civ-token=; Path=/; Max-Age=0; SameSite=Lax",
        "civ-token=; Path=/; Max-Age=0; SameSite=Lax; Domain=civitai.com",
        "__Secure-civ-token=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "__Secure-civ-token=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.com",
        "civ-device=; Path=/; Max-Age=0; SameSite=Lax",
        "civ-device=; Path=/; Max-Age=0; SameSite=Lax; Domain=civitai.com",
        "__Secure-civ-device=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "__Secure-civ-device=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.com",
        "__Host-civ-token=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "__Host-civ-device=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "next-auth.csrf-token=; Path=/; Max-Age=0; SameSite=Lax",
        "__Host-next-auth.csrf-token=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "civitai-token=; Path=/; Max-Age=0; SameSite=Lax",
        "__Secure-civitai-token=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "next-auth.callback-url=; Path=/; Max-Age=0; SameSite=Lax",
        "__Secure-next-auth.callback-url=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "next-auth.state=; Path=/; Max-Age=0; SameSite=Lax",
        "__Secure-next-auth.state=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "next-auth.pkce.code_verifier=; Path=/; Max-Age=0; SameSite=Lax",
        "__Secure-next-auth.pkce.code_verifier=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "next-auth.nonce=; Path=/; Max-Age=0; SameSite=Lax",
        "__Secure-next-auth.nonce=; Path=/; Max-Age=0; SameSite=Lax; Secure",
        "civitai-token=; Path=/; Max-Age=0; SameSite=Lax; Domain=civitai.com",
        "__Secure-civitai-token=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.com",
        "next-auth.callback-url=; Path=/; Max-Age=0; SameSite=Lax; Domain=civitai.com",
        "__Secure-next-auth.callback-url=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.com",
        "next-auth.state=; Path=/; Max-Age=0; SameSite=Lax; Domain=civitai.com",
        "__Secure-next-auth.state=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.com",
        "next-auth.pkce.code_verifier=; Path=/; Max-Age=0; SameSite=Lax; Domain=civitai.com",
        "__Secure-next-auth.pkce.code_verifier=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.com",
        "next-auth.nonce=; Path=/; Max-Age=0; SameSite=Lax; Domain=civitai.com",
        "__Secure-next-auth.nonce=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=civitai.com",
        "civitai-generation=; Path=/; Max-Age=0; SameSite=Lax",
        "civ_postlogin=; Path=/; Max-Age=0; SameSite=Lax",
      ],
    }
  `);
});
