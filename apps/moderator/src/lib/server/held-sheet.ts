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
import type { ReviewTier } from '@civitai/shared/review-batch';
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

export const REVIEW_SHEET_COOKIE = '__Secure-review_sheet';
export const REVIEW_SHEET_COOKIE_PATH = '/api/review-media/';
/** One general sign-in lasts a day: 24 h at most, 8 h idle (Justin, 2026-11-14). Held keeps its own
 *  short session above. */
export const REVIEW_SHEET_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const REVIEW_SHEET_IDLE_MS = 8 * 60 * 60 * 1000;
export const REVIEW_SHEET_MAX_BATCHES = 20;

const BATCH_PATH = /^\/api\/(held|review)-media\/b\/[A-Za-z0-9_-]{22}(?:\/\d{1,3})?$/;
/** The tier a batch route serves, or null for any other path. */
export function batchPathTier(pathname: string): ReviewTier | null {
  const match = BATCH_PATH.exec(pathname);
  if (!match) return null;
  return match[1] === 'held' ? 'held' : 'general';
}

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{16,256}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type StartParams = { challenge: string; state: string; redirect: string };

/** The web session's claims that its revocation is checked by. */
type WebSession = Pick<SessionClaims, 'sub' | 'sid' | 'jti' | 'signedAt'>;
/** The review batch a code was issued for, by its hash, and that batch's tier. */
export type BatchBinding = { hash: string; tier: ReviewTier };
type CodeRecord = StartParams & { userId: number; web: WebSession; batch?: BatchBinding };
/** A held session with `batch` serves that batch's routes and nothing else; one without serves the
 *  image-id route. */
type SessionRecord = { userId: number; web: WebSession; createdAt: number; batch?: string };
type ReviewSessionRecord = {
  userId: number;
  web: WebSession;
  createdAt: number;
  /** The last request it answered; idle past REVIEW_SHEET_IDLE_MS ends it. */
  seenAt?: number;
  batches: string[];
};

const reviewSessionLive = (session: ReviewSessionRecord, now: number) =>
  now - session.createdAt < REVIEW_SHEET_MAX_AGE_MS &&
  now - (session.seenAt ?? session.createdAt) < REVIEW_SHEET_IDLE_MS;

/** Seconds the store keeps it: the idle window, never past the day's cap. */
const reviewTtlSeconds = (session: ReviewSessionRecord, now: number) =>
  Math.max(
    1,
    Math.ceil(
      (Math.min(session.createdAt + REVIEW_SHEET_MAX_AGE_MS, now + REVIEW_SHEET_IDLE_MS) - now) /
        1000
    )
  );

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
const reviewKey = (token: string) =>
  `${REDIS_SYS_KEYS.APP.REVIEW_SHEET_SESSION}:${sha256(token)}` as RedisKeyTemplateSys;

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
  claims: SessionClaims,
  batch?: BatchBinding
): Promise<string> {
  const code = newSecret();
  const record: CodeRecord = {
    ...params,
    userId,
    web: webSession(claims),
    ...(batch && { batch }),
  };
  await getSysRedis().set(codeKey(code), JSON.stringify(record), {
    EX: CODE_TTL_SECONDS,
    NX: true,
  });
  return code;
}

/** The code's record once its verifier matches, or null. The code is consumed before the verifier
 *  is compared, so it answers once whatever the verifier. */
async function redeemCode(code: unknown, codeVerifier: unknown): Promise<CodeRecord | null> {
  if (typeof code !== 'string' || !TOKEN.test(code)) return null;
  if (typeof codeVerifier !== 'string' || !VERIFIER.test(codeVerifier)) return null;

  const raw = await getSysRedis().getDel(codeKey(code));
  if (!raw) return null;
  const record = JSON.parse(raw) as CodeRecord;
  const expected = Buffer.from(record.challenge);
  const actual = Buffer.from(sha256(codeVerifier));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return record;
}

/** A new held sheet session token for a code and its verifier, or null. A general-tier code is
 *  refused here: it can only become a review session. */
export async function exchangeCode(code: unknown, codeVerifier: unknown): Promise<string | null> {
  const record = await redeemCode(code, codeVerifier);
  if (!record || (record.batch && record.batch.tier !== 'held')) return null;

  const token = newSecret();
  const session: SessionRecord = {
    userId: record.userId,
    web: record.web,
    createdAt: Date.now(),
    ...(record.batch && { batch: record.batch.hash }),
  };
  await getSysRedis().set(sessionKey(token), JSON.stringify(session), {
    EX: SHEET_IDLE_SECONDS,
  });
  return token;
}

/**
 * The review session token a general-tier code adds its batch to: the session `current` names when
 * it is live and belongs to the same moderator, else a new one. Only a code, which only a web session
 * can issue, ever adds a batch; the cookie alone cannot.
 */
export async function exchangeReviewCode(
  code: unknown,
  codeVerifier: unknown,
  current: string | undefined
): Promise<string | null> {
  const record = await redeemCode(code, codeVerifier);
  if (!record || record.batch?.tier !== 'general') return null;
  const redis = getSysRedis();
  const now = Date.now();

  const existing = current && TOKEN.test(current) ? await redis.get(reviewKey(current)) : null;
  const live = existing ? (JSON.parse(existing) as ReviewSessionRecord) : null;
  const joinable =
    live &&
    live.userId === record.userId &&
    reviewSessionLive(live, now) &&
    (live.batches.includes(record.batch.hash) || live.batches.length < REVIEW_SHEET_MAX_BATCHES);

  const token = joinable ? current! : newSecret();
  const session: ReviewSessionRecord = joinable
    ? { ...live, seenAt: now, batches: [...new Set([...live.batches, record.batch.hash])] }
    : {
        userId: record.userId,
        web: record.web,
        createdAt: now,
        seenAt: now,
        batches: [record.batch.hash],
      };
  await redis.set(reviewKey(token), JSON.stringify(session), {
    EX: reviewTtlSeconds(session, now),
  });
  return token;
}

/** Ends a review session (the sheet's Sign out). A token that names none is a no-op. */
export async function revokeReviewSession(token: string | undefined): Promise<void> {
  if (!token || !TOKEN.test(token)) return;
  await getSysRedis().del(reviewKey(token));
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
  const resolved = await resolveHeldSession(token);
  return resolved && !resolved.batch ? resolved.user : null;
}

/** A held sheet session and the batch it is bound to, if any. */
export async function resolveHeldSession(
  token: string | undefined
): Promise<{ user: SessionUser; batch: string | null } | null> {
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
  const user = await sessionUser(session);
  if (!user) return null;

  await redis.expire(key, SHEET_IDLE_SECONDS);
  return { user, batch: session.batch ?? null };
}

/**
 * A review sheet session, the general batches it holds, and `join`, which adds one more. A hit
 * slides the idle window; the session never outlives REVIEW_SHEET_MAX_AGE_MS or the web session
 * that started it. `join` only records a hash: the caller has already checked the batch is live,
 * general, minted for this moderator, and that its minting key is live.
 */
export async function resolveReviewSession(token: string | undefined): Promise<{
  user: SessionUser;
  batches: string[];
  join: (hash: string) => Promise<boolean>;
} | null> {
  if (!token || !TOKEN.test(token)) return null;
  const redis = getSysRedis();
  const key = reviewKey(token);
  const raw = await redis.get(key);
  if (!raw) return null;
  const session = JSON.parse(raw) as ReviewSessionRecord;
  const now = Date.now();
  if (!reviewSessionLive(session, now)) {
    await redis.del(key);
    return null;
  }
  const user = await sessionUser(session);
  if (!user) return null;

  session.seenAt = now;
  const save = () =>
    redis.set(key, JSON.stringify(session), { EX: reviewTtlSeconds(session, now) });
  await save();
  const join = async (hash: string) => {
    if (session.batches.includes(hash)) return true;
    if (session.batches.length >= REVIEW_SHEET_MAX_BATCHES) return false;
    session.batches = [...session.batches, hash];
    await save();
    return true;
  };
  return { user, batches: session.batches, join };
}

async function sessionUser(session: { userId: number; web: WebSession }) {
  if (!session.web?.jti || (await isRevoked(session.web))) return null;
  const user = await (sessions ??= createSessionClient()).getSessionUserById(session.userId);
  return admitsSheetUser(user) && user.id === session.userId ? user : null;
}

export const clearedReviewCookie = () =>
  `${REVIEW_SHEET_COOKIE}=; Path=${REVIEW_SHEET_COOKIE_PATH}; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;

export const reviewCookie = (token: string) =>
  `${REVIEW_SHEET_COOKIE}=${token}; Path=${REVIEW_SHEET_COOKIE_PATH}; Max-Age=${Math.floor(
    REVIEW_SHEET_MAX_AGE_MS / 1000
  )}; Secure; HttpOnly; SameSite=Strict`;

/** Clears a sheet cookie the server no longer honours. */
export const clearedSheetCookie = () => sheetCookie('', 0);

export function sheetCookie(token: string, maxAge = SHEET_IDLE_SECONDS): string {
  return `${SHEET_COOKIE}=${token}; Path=${SHEET_COOKIE_PATH}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

/** The review batch routes and their sign-in answer 404 unless this is exactly 'true'. */
export const reviewBatchesEnabled = () => env.REVIEW_BATCHES_ENABLED === 'true';
