import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createAuthVerifier,
  createSessionClient,
  parseCookieHeader,
  readSessionToken,
  type SessionClaims,
  type SessionUser,
} from '@civitai/auth';
import { REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { env } from '$env/dynamic/private';
import { admitsModerator, isRevoked } from './auth';
import { getSysRedis } from './redis';

/**
 * The held-media phone sheet signs in with a PKCE code: `auth/start` (behind the moderator's web
 * session) issues a code, `auth/exchange` trades it with the verifier for a session cookie scoped to
 * `/api/held-media/`, and the image route accepts that cookie in place of the web session.
 */

export const SHEET_COOKIE = '__Secure-held_sheet';
export const SHEET_COOKIE_PATH = '/api/held-media/';
export const CODE_TTL_SECONDS = 60;
export const SHEET_IDLE_SECONDS = 15 * 60;
export const SHEET_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** The only types served to the sheet. */
export const SHEET_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const SHEET_IMAGE_PATH = /^\/api\/held-media\/\d{1,20}$/;
export const isSheetImagePath = (pathname: string) => SHEET_IMAGE_PATH.test(pathname);

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{16,256}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type StartParams = { challenge: string; state: string; redirect: string };

/** The web session's claims that its revocation is checked by. */
type WebSession = Pick<SessionClaims, 'sub' | 'sid' | 'jti' | 'signedAt'>;
type CodeRecord = StartParams & { userId: number; web: WebSession };
type SessionRecord = { userId: number; web: WebSession; createdAt: number };

const webSession = ({ sub, sid, jti, signedAt }: SessionClaims): WebSession => ({
  sub,
  sid,
  jti,
  signedAt,
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const newSecret = () => randomBytes(32).toString('base64url');
const codeKey = (code: string) =>
  `${REDIS_SYS_KEYS.APP.HELD_SHEET_CODE}:${sha256(code)}` as RedisKeyTemplateSys;
const sessionKey = (token: string) =>
  `${REDIS_SYS_KEYS.APP.HELD_SHEET_SESSION}:${sha256(token)}` as RedisKeyTemplateSys;

/**
 * The one redirect the sheet may name: `HELD_SHEET_CALLBACK_URL`, an https URL with no query,
 * fragment or credentials, written in its normalised form. Null when unset or not that.
 */
export function sheetCallbackUrl(): string | null {
  const raw = env.HELD_SHEET_CALLBACK_URL?.trim();
  // A bare trailing `?` or `#` parses to an empty search/hash but would mangle the redirect.
  if (!raw || /[?#]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password)
    return null;
  return url.href === raw ? raw : null;
}

/** The start parameters, or null when any is missing or not exactly what the sheet sends. */
export function parseStartParams(get: (name: string) => string | null): StartParams | null {
  const challenge = get('code_challenge') ?? '';
  const state = get('state') ?? '';
  const redirect = get('redirect_uri') ?? '';
  if (get('code_challenge_method') !== 'S256') return null;
  const callback = sheetCallbackUrl();
  if (!BASE64URL_43.test(challenge) || !STATE.test(state) || !callback || redirect !== callback)
    return null;
  return { challenge, state, redirect };
}

let verifier: ReturnType<typeof createAuthVerifier> | undefined;

/** The claims of the web session this request carries, for binding a sheet session to it. */
export async function webSessionClaims(cookieHeader: string): Promise<SessionClaims | null> {
  const read = readSessionToken(parseCookieHeader(cookieHeader));
  if (!read) return null;
  return (verifier ??= createAuthVerifier({ isRevoked })).verifyToken(read.value);
}

/** A single-use code for `params`, bound to the moderator and their web session. */
export async function issueCode(
  params: StartParams,
  userId: number,
  claims: SessionClaims
): Promise<string> {
  const code = newSecret();
  const record: CodeRecord = { ...params, userId, web: webSession(claims) };
  await getSysRedis().set(codeKey(code), JSON.stringify(record), {
    EX: CODE_TTL_SECONDS,
    NX: true,
  });
  return code;
}

/**
 * A new sheet session token for a code and its verifier, or null. The code is consumed before the
 * verifier is compared, so it answers once whatever the verifier.
 */
export async function exchangeCode(code: unknown, codeVerifier: unknown): Promise<string | null> {
  if (typeof code !== 'string' || !TOKEN.test(code)) return null;
  if (typeof codeVerifier !== 'string' || !VERIFIER.test(codeVerifier)) return null;

  const raw = await getSysRedis().getDel(codeKey(code));
  if (!raw) return null;
  const record = JSON.parse(raw) as CodeRecord;
  const expected = Buffer.from(record.challenge);
  const actual = Buffer.from(sha256(codeVerifier));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const token = newSecret();
  const session: SessionRecord = { userId: record.userId, web: record.web, createdAt: Date.now() };
  await getSysRedis().set(sessionKey(token), JSON.stringify(session), {
    EX: SHEET_IDLE_SECONDS,
  });
  return token;
}

let sessions: ReturnType<typeof createSessionClient> | undefined;

/** Admits the same users the web guard does; also refuses a banned or deleted account. */
export function admitsSheetUser(user: SessionUser | null): user is SessionUser {
  return !!user && !user.bannedAt && !user.deletedAt && admitsModerator(user);
}

/**
 * The moderator behind a sheet session token, looked up fresh, or null. A hit slides the idle
 * expiry; the session never outlives `SHEET_MAX_AGE_MS` or the web session that started it.
 * Throws when the session store cannot be read.
 */
export async function resolveSheetSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token || !TOKEN.test(token)) return null;
  const redis = getSysRedis();
  const key = sessionKey(token);
  const raw = await redis.get(key);
  if (!raw) return null;
  const session = JSON.parse(raw) as SessionRecord;
  if (Date.now() - session.createdAt > SHEET_MAX_AGE_MS) {
    await redis.del(key);
    return null;
  }
  if (!session.web?.jti || (await isRevoked(session.web))) return null;

  const user = await (sessions ??= createSessionClient()).getSessionUserById(session.userId);
  if (!admitsSheetUser(user) || user.id !== session.userId) return null;

  await redis.expire(key, SHEET_IDLE_SECONDS);
  return user;
}

/** Clears a sheet cookie the server no longer honours. */
export const clearedSheetCookie = () => sheetCookie('', 0);

export function sheetCookie(token: string, maxAge = SHEET_IDLE_SECONDS): string {
  return `${SHEET_COOKIE}=${token}; Path=${SHEET_COOKIE_PATH}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}
