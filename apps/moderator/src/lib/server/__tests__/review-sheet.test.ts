import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReviewBatchModule from '../review-batch';

/**
 * Review batches on the moderator app: signing the sheet in to a batch (`auth/start?batch`,
 * `auth/exchange` for each tier), the hook that lets only that tier's sheet cookie reach a batch
 * route, and the batch routes' refusals. Redis is an in-memory fake; storage, the image read and the
 * hub identity are replaced, so what is under test is who gets which image.
 */

type Entry = { value: string; expiresAt: number | null };

const {
  store,
  redis,
  getSessionUserById,
  verifyToken,
  isRevoked,
  guardCheck,
  getBatchMedia,
  mintingKeyLive,
  scannerHoldsImage,
  streamStoredMedia,
  insertModActivity,
} = vi.hoisted(() => {
  const store = new Map<string, Entry>();
  const live = (key: string) => {
    const e = store.get(key);
    if (e && e.expiresAt !== null && Date.now() >= e.expiresAt) store.delete(key);
    return store.get(key);
  };
  const redis = {
    set: vi.fn(async (key: string, value: string, opts?: { EX?: number; NX?: boolean }) => {
      if (opts?.NX && live(key)) return null;
      store.set(key, { value, expiresAt: opts?.EX ? Date.now() + opts.EX * 1000 : null });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => live(key)?.value ?? null),
    getDel: vi.fn(async (key: string) => {
      const e = live(key);
      store.delete(key);
      return e?.value ?? null;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    expire: vi.fn(async (key: string, seconds: number) => {
      const e = live(key);
      if (!e) return 0;
      e.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }),
  };
  return {
    store,
    redis,
    getSessionUserById: vi.fn(async (_id: number) => null as unknown),
    verifyToken: vi.fn(async (_token: string) => null as unknown),
    isRevoked: vi.fn(async (_claims: unknown) => false),
    guardCheck: vi.fn(async (_cookie: string, _url: string, _opts?: unknown) => ({} as unknown)),
    getBatchMedia: vi.fn(),
    mintingKeyLive: vi.fn(async (_keyId: number) => true),
    scannerHoldsImage: vi.fn(async (_imageId: number) => false),
    streamStoredMedia: vi.fn(async (input: { audit: () => Promise<unknown> }) => {
      await input.audit();
      return new Response('bytes', { status: 200 });
    }),
    insertModActivity: vi.fn(async (_row: unknown) => undefined),
  };
});

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$lib/server/redis', () => ({ getSysRedis: () => redis }));
vi.mock('$lib/server/auth', () => ({
  guard: { check: guardCheck },
  isRevoked,
  admitsModerator: (u: { isModerator?: boolean }) => u.isModerator === true,
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@civitai/auth')>()),
  createSessionClient: () => ({ getSessionUserById }),
  createAuthVerifier: () => ({ verifyToken }),
}));
vi.mock('$lib/server/page-access', () => ({ loadPageAccessGrants: vi.fn(async () => ({})) }));
// Senior moderators open held media; staff open the image lookup only.
vi.mock('$lib/server/access', () => ({
  applyGrants: () => {},
  resolvePermissions: () => ({}),
  canAccess: (user: { roles?: string[] }, path: string) =>
    (path === '/images/csam' && !!user.roles?.includes('moderator:senior')) ||
    (path === '/retool/image-lookup' &&
      !!user.roles?.some((r) => r === 'moderator:senior' || r === 'moderator:staff')),
}));
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(async () => undefined),
  safeError: (e: unknown) => ({ e }),
}));
vi.mock('$lib/server/review-batch', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewBatchModule>()),
  getBatchMedia,
  mintingKeyLive,
  scannerHoldsImage,
}));
vi.mock('$lib/server/held-media-stream', () => ({ streamStoredMedia }));
vi.mock('$lib/server/mod-activity', () => ({
  insertModActivity,
  recordModActivity: vi.fn(),
}));

const heldStart = await import('../../../routes/api/held-media/auth/start/+server');
const heldExchange = await import('../../../routes/api/held-media/auth/exchange/+server');
const reviewStart = await import('../../../routes/api/review-media/auth/start/+server');
const reviewExchange = await import('../../../routes/api/review-media/auth/exchange/+server');
const heldItem = await import('../../../routes/api/held-media/b/[batchId]/[n]/+server');
const reviewItem = await import('../../../routes/api/review-media/b/[batchId]/[n]/+server');
const reviewCount = await import('../../../routes/api/review-media/b/[batchId]/+server');
const { handle } = await import('../../../hooks.server');
const { reviewBatchHash } = await import('@civitai/shared/review-batch');

const ORIGIN = 'https://mod.test';
const CALLBACK = 'https://sheet.test/held-media/callback';
const VERIFIER = 'v'.repeat(20) + '-._~' + 'A1'.repeat(12);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const STATE = 'S'.repeat(24);
const MOD = { id: 42, username: 'mod42', isModerator: true, roles: ['moderator:senior'] };
const CLAIMS = { sub: '42', sid: 'family-1', jti: 'web-session-1', signedAt: 1_000, iat: 5 };

const { hostSessionCookieName, sessionCookieName } = await import('@civitai/auth');
const WEB_COOKIE = `${hostSessionCookieName()}=web.jwt; ${sessionCookieName()}=web.jwt`;

const GENERAL = 'G'.repeat(22);
const GENERAL_2 = 'H'.repeat(22);
const HELD = 'Z'.repeat(22);
const OTHER_VIEWER = 'O'.repeat(22);

function seedBatch(batchId: string, tier: 'general' | 'held', over: Record<string, unknown> = {}) {
  const record = {
    ids: [101, 102],
    tier,
    declared: false,
    viewer: MOD.id,
    createdBy: 7,
    keyId: 9,
    seat: null,
    createdAt: Date.now(),
    ...over,
  };
  store.set(`app:review-batch:${reviewBatchHash(batchId)}`, {
    value: JSON.stringify(record),
    expiresAt: null,
  });
}

const form = (batch: string | null) => {
  const u = new URLSearchParams({
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: STATE,
    redirect_uri: CALLBACK,
  });
  if (batch) u.set('batch', batch);
  return u;
};

type Family = 'held' | 'review';
const startOf = { held: heldStart, review: reviewStart };
const exchangeOf = { held: heldExchange, review: reviewExchange };
const COOKIE = { held: '__Secure-held_sheet', review: '__Secure-review_sheet' };

async function startPost(family: Family, batch: string | null, user: unknown = MOD) {
  const url = new URL(`${ORIGIN}/api/${family}-media/auth/start`);
  const request = new Request(url, {
    method: 'POST',
    headers: { cookie: WEB_COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
    body: form(batch),
  });
  return startOf[family].POST({ url, locals: { user }, request } as never);
}

async function exchange(family: Family, code: string, cookie?: string) {
  const url = new URL(`${ORIGIN}/api/${family}-media/auth/exchange`);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const request = new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code, code_verifier: VERIFIER }),
  });
  const cookies = {
    get: (name: string) => (cookie?.startsWith(`${name}=`) ? cookie.split('=')[1] : undefined),
  };
  return exchangeOf[family].POST({ url, request, locals: {}, cookies } as never);
}

/** Start + exchange; the token of the cookie the exchange set, or null when either step refused. */
async function signIn(family: Family, batch: string | null, current?: string) {
  const started = await startPost(family, batch);
  if (started.status !== 303) return null;
  const code = new URL(started.headers.get('location')!).searchParams.get('code')!;
  const res = await exchange(family, code, current ? `${COOKIE[family]}=${current}` : undefined);
  if (res.status !== 204) return null;
  return new RegExp(`${COOKIE[family]}=([^;]+)`).exec(res.headers.get('set-cookie')!)![1];
}

async function hook(path: string, cookie: string | null) {
  const url = new URL(`${ORIGIN}${path}`);
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  const event = {
    url,
    request: new Request(url, { headers }),
    locals: {} as Record<string, unknown>,
    route: { id: '/api/review-media/b/[batchId]/[n]' },
  };
  const resolve = vi.fn(async () => new Response(null, { status: 299 }));
  const res = await handle({ event, resolve } as never);
  return { res, resolve, locals: event.locals as unknown as App.Locals };
}

const item = (family: Family, batchId: string, n: string, locals: App.Locals) => {
  const url = new URL(`${ORIGIN}/api/${family}-media/b/${batchId}/${n}`);
  const route = family === 'held' ? heldItem : reviewItem;
  return Promise.resolve(
    route.GET({
      params: { batchId, n },
      locals,
      request: new Request(url),
      url,
      cookies: { get: () => undefined },
    } as never)
  ).catch((e: { status?: number }) => ({ status: e.status ?? 500 } as Response));
};

const reviewLocals = (batches: string[], user: unknown = MOD) =>
  ({ user, grants: {}, reviewSheet: { tier: 'general', batches } } as unknown as App.Locals);
const heldLocals = (batches: string[]) =>
  ({ user: MOD, grants: {}, reviewSheet: { tier: 'held', batches } } as unknown as App.Locals);

beforeEach(() => {
  process.env.HELD_SHEET_CALLBACK_URL = CALLBACK;
  process.env.REVIEW_BATCHES_ENABLED = 'true';
  store.clear();
  vi.clearAllMocks();
  verifyToken.mockResolvedValue(CLAIMS);
  getSessionUserById.mockResolvedValue({ ...MOD });
  isRevoked.mockResolvedValue(false);
  mintingKeyLive.mockResolvedValue(true);
  scannerHoldsImage.mockResolvedValue(false);
  getBatchMedia.mockResolvedValue({
    imageId: 101,
    url: 'k',
    type: 'image',
    mimeType: null,
    held: false,
  });
  seedBatch(GENERAL, 'general');
  seedBatch(GENERAL_2, 'general');
  seedBatch(HELD, 'held');
  seedBatch(OTHER_VIEWER, 'general', { viewer: 999 });
});

describe('signing in to a batch', () => {
  it('binds a code to a batch of its own tier, minted for this moderator', async () => {
    expect(await signIn('review', GENERAL)).not.toBeNull();
    expect(await signIn('held', HELD)).not.toBeNull();
  });

  it('refuses a batch of the other tier, another viewer, an unknown id, or none on the general family', async () => {
    expect((await startPost('review', HELD)).status).toBe(404);
    expect((await startPost('held', GENERAL)).status).toBe(404);
    expect((await startPost('review', OTHER_VIEWER)).status).toBe(404);
    expect((await startPost('review', 'X'.repeat(22))).status).toBe(404);
    expect((await startPost('review', null)).status).toBe(400);
  });

  it('refuses everything while the batch routes are switched off', async () => {
    process.env.REVIEW_BATCHES_ENABLED = '';
    expect((await startPost('review', GENERAL)).status).toBe(404);
    expect((await hook(`/api/review-media/b/${GENERAL}`, 'x=y')).res.status).toBe(404);
  });

  it('a general code never becomes a held session, nor a held code a review session', async () => {
    const started = await startPost('review', GENERAL);
    const code = new URL(started.headers.get('location')!).searchParams.get('code')!;
    expect((await exchange('held', code)).status).toBe(400);
    const startedHeld = await startPost('held', HELD);
    const heldCode = new URL(startedHeld.headers.get('location')!).searchParams.get('code')!;
    expect((await exchange('review', heldCode)).status).toBe(400);
  });

  it('a later general batch joins the live review session, through a new code only', async () => {
    const token = (await signIn('review', GENERAL))!;
    expect(await signIn('review', GENERAL_2, token)).toBe(token);
    const { locals } = await hook(`/api/review-media/b/${GENERAL_2}`, `${COOKIE.review}=${token}`);
    expect(locals.reviewSheet!.batches).toHaveLength(2);
  });

  it('the review cookie alone cannot enroll a batch', async () => {
    const token = (await signIn('review', GENERAL))!;
    const { res, locals } = await hook(
      `/api/review-media/b/${GENERAL_2}`,
      `${COOKIE.review}=${token}`
    );
    expect(res.status).toBe(299);
    expect(locals.reviewSheet!.batches).toEqual([reviewBatchHash(GENERAL)]);
    expect(
      (
        await Promise.resolve(
          reviewCount.GET({ params: { batchId: GENERAL_2 }, locals } as never)
        ).catch((e: { status: number }) => e)
      ).status
    ).toBe(404);
  });
});

describe('the hook on batch routes', () => {
  it('accepts only the sheet cookie of the route tier', async () => {
    const review = (await signIn('review', GENERAL))!;
    const held = (await signIn('held', HELD))!;
    expect(
      (await hook(`/api/review-media/b/${GENERAL}/0`, `${COOKIE.review}=${review}`)).res.status
    ).toBe(299);
    expect((await hook(`/api/held-media/b/${HELD}/0`, `${COOKIE.held}=${held}`)).res.status).toBe(
      299
    );
    expect(
      (await hook(`/api/held-media/b/${HELD}/0`, `${COOKIE.review}=${review}`)).res.status
    ).toBe(401);
    expect(
      (await hook(`/api/review-media/b/${GENERAL}/0`, `${COOKIE.held}=${held}`)).res.status
    ).toBe(401);
  });

  it('refuses a web session on both batch route families', async () => {
    guardCheck.mockResolvedValue({ status: 'ok', user: MOD, setCookies: [] });
    for (const path of [`/api/review-media/b/${GENERAL}/0`, `/api/held-media/b/${HELD}/0`]) {
      const { res, resolve } = await hook(path, WEB_COOKIE);
      expect(res.status).toBe(401);
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('an image-id held session cannot open a held batch', async () => {
    const legacy = (await signIn('held', null))!;
    const { res, resolve } = await hook(`/api/held-media/b/${HELD}/0`, `${COOKIE.held}=${legacy}`);
    expect(res.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('the batch item routes', () => {
  const GENERAL_HASH = reviewBatchHash(GENERAL);
  const HELD_HASH = reviewBatchHash(HELD);

  it('serves a clean image on the general tier and audits it with the batch hash, not the id', async () => {
    expect((await item('review', GENERAL, '0', reviewLocals([GENERAL_HASH]))).status).toBe(200);
    expect(insertModActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: 'review-media-served',
        entityId: 101,
        review: { batchHash: GENERAL_HASH, tier: 'general', declared: false },
      })
    );
    expect(JSON.stringify(insertModActivity.mock.calls)).not.toContain(GENERAL);
  });

  it('answers 409 moved, serving nothing, when a general image carries a signal at fetch', async () => {
    getBatchMedia.mockResolvedValue({
      imageId: 101,
      url: 'k',
      type: 'image',
      mimeType: null,
      held: true,
    });
    const res = await item('review', GENERAL, '0', reviewLocals([GENERAL_HASH]));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ moved: true });
    expect(streamStoredMedia).not.toHaveBeenCalled();
  });

  it('a held batch serves a suspect image, and refuses a clean one unless the batch was declared', async () => {
    getBatchMedia.mockResolvedValue({
      imageId: 101,
      url: 'k',
      type: 'image',
      mimeType: null,
      held: true,
    });
    expect((await item('held', HELD, '0', heldLocals([HELD_HASH]))).status).toBe(200);
    getBatchMedia.mockResolvedValue({
      imageId: 101,
      url: 'k',
      type: 'image',
      mimeType: null,
      held: false,
    });
    expect((await item('held', HELD, '0', heldLocals([HELD_HASH]))).status).toBe(404);
    scannerHoldsImage.mockResolvedValueOnce(true);
    expect((await item('held', HELD, '0', heldLocals([HELD_HASH]))).status).toBe(200);
    seedBatch(HELD, 'held', { declared: true });
    expect((await item('held', HELD, '0', heldLocals([HELD_HASH]))).status).toBe(200);
  });

  it('refuses an index past the batch, a batch not in the session, a tier mismatch, or a dead minting key', async () => {
    expect((await item('review', GENERAL, '2', reviewLocals([GENERAL_HASH]))).status).toBe(404);
    expect((await item('review', GENERAL, '0', reviewLocals([]))).status).toBe(404);
    expect((await item('review', HELD, '0', reviewLocals([HELD_HASH]))).status).toBe(404);
    mintingKeyLive.mockResolvedValueOnce(false);
    expect((await item('review', GENERAL, '0', reviewLocals([GENERAL_HASH]))).status).toBe(404);
    expect(streamStoredMedia).not.toHaveBeenCalled();
  });

  it('a moderator without the tier page grant is refused', async () => {
    const staff = { ...MOD, roles: ['moderator:staff'] };
    expect(
      (await item('held', HELD, '0', { ...heldLocals([HELD_HASH]), user: staff } as never)).status
    ).toBe(403);
    expect((await item('review', GENERAL, '0', reviewLocals([GENERAL_HASH], staff))).status).toBe(
      200
    );
  });
});
