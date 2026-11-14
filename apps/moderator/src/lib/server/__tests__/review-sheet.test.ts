import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReviewBatchModule from '../review-batch';

/**
 * Review batches on the moderator app: signing the sheet in to a batch (`auth/start?batch`,
 * `auth/exchange` for each tier), the hook that lets only that tier's sheet cookie reach a batch
 * route, and the batch routes' refusals. Redis is an in-memory fake; storage, the image read and the
 * hub identity are replaced, so what is under test is who gets which image.
 */

type Entry = { value: string | Set<string>; expiresAt: number | null };

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
    get: vi.fn(async (key: string) => {
      const v = live(key)?.value;
      return typeof v === 'string' ? v : null;
    }),
    exists: vi.fn(async (key: string) => (live(key) ? 1 : 0)),
    // Sets, as Redis: each command is atomic; a ticked await between them lets requests interleave.
    sAdd: vi.fn(async (key: string, value: string) => {
      await Promise.resolve();
      const e = live(key);
      const set = e?.value instanceof Set ? e.value : new Set<string>();
      const had = set.has(value);
      set.add(value);
      if (!e) store.set(key, { value: set, expiresAt: null });
      return had ? 0 : 1;
    }),
    sRem: vi.fn(async (key: string, value: string) => {
      const v = live(key)?.value;
      return v instanceof Set && v.delete(value) ? 1 : 0;
    }),
    sCard: vi.fn(async (key: string) => {
      await Promise.resolve();
      const v = live(key)?.value;
      return v instanceof Set ? v.size : 0;
    }),
    sMembers: vi.fn(async (key: string) => {
      const v = live(key)?.value;
      return v instanceof Set ? [...v] : [];
    }),
    getDel: vi.fn(async (key: string) => {
      const e = live(key);
      store.delete(key);
      return typeof e?.value === 'string' ? e.value : null;
    }),
    del: vi.fn(async (keys: string | string[]) =>
      [keys].flat().reduce((n, key) => n + (store.delete(key) ? 1 : 0), 0)
    ),
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
const signout = await import('../../../routes/api/review-media/auth/signout/+server');
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
});

// Deliberate product decision: one general sign-in lasts the day, so the review cookie itself joins
// each new general batch minted for this moderator. Making the cookie unable to enroll a batch
// again puts a Continue tap back on every batch, the option that was declined.
describe('one general sign-in a day', () => {
  const H = (id: string) => reviewBatchHash(id);
  const open = async (family: Family, batchId: string, token: string, n = '0') => {
    const { res, locals } = await hook(
      `/api/${family}-media/b/${batchId}/${n}`,
      `${COOKIE[family]}=${token}`
    );
    if (res.status !== 299) return res.status;
    return (await item(family, batchId, n, locals)).status;
  };
  const batchesOf = async (token: string) =>
    (await hook(`/api/review-media/b/${GENERAL}`, `${COOKIE.review}=${token}`)).locals.reviewSheet
      ?.batches ?? null;

  it('the review cookie joins a second live general batch minted for this moderator', async () => {
    const token = (await signIn('review', GENERAL))!;
    expect(await open('review', GENERAL_2, token)).toBe(200);
    expect(await batchesOf(token)).toEqual([H(GENERAL), H(GENERAL_2)]);
  });

  it('a held session never joins a batch by its cookie, even its own viewer with a live key', async () => {
    const HELD_2 = 'Y'.repeat(22);
    seedBatch(HELD_2, 'held');
    const held = (await signIn('held', HELD))!;
    expect(await open('held', HELD, held)).toBe(200);
    expect(await open('held', HELD_2, held)).toBe(404);
  });

  it("another moderator's general batch is refused and not joined", async () => {
    const token = (await signIn('review', GENERAL))!;
    expect(await open('review', OTHER_VIEWER, token)).toBe(404);
    expect(await batchesOf(token)).toEqual([H(GENERAL)]);
  });

  it('a held batch on the general route is refused and not joined', async () => {
    const token = (await signIn('review', GENERAL))!;
    expect(await open('review', HELD, token)).toBe(404);
    expect(await batchesOf(token)).toEqual([H(GENERAL)]);
  });

  it('the 21st batch is refused', async () => {
    const token = (await signIn('review', GENERAL))!;
    const ids = Array.from({ length: 20 }, (_, i) => `B${String(i).padStart(21, '0')}`);
    ids.forEach((id) => seedBatch(id, 'general'));
    for (const id of ids.slice(0, 19)) expect(await open('review', id, token)).toBe(200);
    expect(await batchesOf(token)).toHaveLength(20);
    expect(await open('review', ids[19], token)).toBe(404);
    expect(await batchesOf(token)).toHaveLength(20);
  });

  it("a code signs in fresh when the cookie's session is full or another moderator's", async () => {
    const token = (await signIn('review', GENERAL))!;
    const ids = Array.from({ length: 19 }, (_, i) => `B${String(i).padStart(21, '0')}`);
    ids.forEach((id) => seedBatch(id, 'general'));
    for (const id of ids) expect(await open('review', id, token)).toBe(200);
    const full = await batchesOf(token);
    expect(full).toHaveLength(20);

    const fresh = await signIn('review', GENERAL_2, token);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(token);
    expect(await batchesOf(fresh!)).toEqual([H(GENERAL_2)]);
    expect(await batchesOf(token)).toEqual(full);

    const OTHER_MOD = { ...MOD, id: 999, username: 'mod999' };
    verifyToken.mockResolvedValueOnce({ ...CLAIMS, sub: '999' });
    getSessionUserById.mockImplementation(async (id: number) => (id === 999 ? OTHER_MOD : MOD));
    const started = await startPost('review', OTHER_VIEWER, OTHER_MOD);
    expect(started.status).toBe(303);
    const code = new URL(started.headers.get('location')!).searchParams.get('code')!;
    const res = await exchange('review', code, `${COOKIE.review}=${fresh}`);
    expect(res.status).toBe(204);
    const theirs = new RegExp(`${COOKIE.review}=([^;]+)`).exec(res.headers.get('set-cookie')!)![1];
    expect(theirs).not.toBe(fresh);
    expect(await batchesOf(fresh!)).toEqual([H(GENERAL_2)]);
  });

  it('a batch whose minting key is revoked, or that is no longer live, is refused and not joined', async () => {
    const token = (await signIn('review', GENERAL))!;
    mintingKeyLive.mockResolvedValueOnce(false);
    expect(await open('review', GENERAL_2, token)).toBe(404);
    store.delete(`app:review-batch:${H(GENERAL_2)}`);
    expect(await open('review', GENERAL_2, token)).toBe(404);
    expect(await batchesOf(token)).toEqual([H(GENERAL)]);
  });

  it('idle for 8 h and a minute ends it; so does 24 h and a minute, however active', async () => {
    vi.useFakeTimers();
    try {
      const idle = (await signIn('review', GENERAL))!;
      vi.advanceTimersByTime(8 * 3600_000 - 60_000);
      expect(await open('review', GENERAL, idle)).toBe(200);
      vi.advanceTimersByTime(8 * 3600_000 + 60_000);
      expect(await open('review', GENERAL, idle)).toBe(401);

      const busy = (await signIn('review', GENERAL))!;
      for (let h = 4; h < 24; h += 4) {
        vi.advanceTimersByTime(4 * 3600_000);
        expect(await open('review', GENERAL, busy)).toBe(200);
      }
      vi.advanceTimersByTime(4 * 3600_000 - 120_000);
      expect(await open('review', GENERAL, busy)).toBe(200);
      vi.advanceTimersByTime(180_000);
      expect(await open('review', GENERAL, busy)).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the count route joins a batch the same way, and refuses one it may not', async () => {
    const token = (await signIn('review', GENERAL))!;
    const count = async (batchId: string) => {
      const { res, locals } = await hook(
        `/api/review-media/b/${batchId}`,
        `${COOKIE.review}=${token}`
      );
      if (res.status !== 299) return res.status;
      return Promise.resolve(reviewCount.GET({ params: { batchId }, locals } as never)).then(
        (r: Response) => r.status,
        (e: { status: number }) => e.status
      );
    };
    expect(await count(GENERAL_2)).toBe(200);
    expect(await count(OTHER_VIEWER)).toBe(404);
    expect(await batchesOf(token)).toEqual([H(GENERAL), H(GENERAL_2)]);
  });

  it('concurrent first opens never take a session past 20 batches or drop a joined one', async () => {
    const token = (await signIn('review', GENERAL))!;
    const ids = Array.from({ length: 25 }, (_, i) => `C${String(i).padStart(21, '0')}`);
    ids.forEach((id) => seedBatch(id, 'general'));
    const statuses = await Promise.all(ids.map((id) => open('review', id, token)));
    const held = await batchesOf(token);
    expect(held!.length).toBeLessThanOrEqual(20);
    const opened = ids.filter((_, i) => statuses[i] === 200).map(H);
    expect(opened.every((h) => held!.includes(h))).toBe(true);
  });

  it('a request in flight cannot bring a signed-out session back', async () => {
    const token = (await signIn('review', GENERAL))!;
    let release!: () => void;
    getSessionUserById.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ...MOD })))
    );
    const inFlight = open('review', GENERAL_2, token);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await signout.POST({
      cookies: { get: (n: string) => (n === COOKIE.review ? token : undefined) },
    } as never);
    release();
    expect(await inFlight).not.toBe(200);
    expect(await open('review', GENERAL, token)).toBe(401);
  });

  it('a join in flight when sign out lands leaves nothing behind', async () => {
    const token = (await signIn('review', GENERAL))!;
    let release!: () => void;
    // Paused after the session was read and slid, before the batch joins.
    mintingKeyLive.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(true)))
    );
    const inFlight = open('review', GENERAL_2, token);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await signout.POST({
      cookies: { get: (n: string) => (n === COOKIE.review ? token : undefined) },
    } as never);
    release();
    expect(await inFlight).toBe(404);
    expect([...store.keys()].filter((k) => k.startsWith('app:review-sheet:session'))).toEqual([]);
  });

  it('a revoked web session ends it on the next request', async () => {
    const token = (await signIn('review', GENERAL))!;
    expect(await open('review', GENERAL, token)).toBe(200);
    isRevoked.mockResolvedValue(true);
    expect(await open('review', GENERAL, token)).toBe(401);
  });

  it('a ban, or losing the moderator role, ends it on the next request', async () => {
    const token = (await signIn('review', GENERAL))!;
    getSessionUserById.mockResolvedValueOnce({ ...MOD, bannedAt: new Date() });
    expect(await open('review', GENERAL, token)).toBe(401);
    getSessionUserById.mockResolvedValueOnce({ ...MOD, isModerator: false });
    expect(await open('review', GENERAL, token)).toBe(401);
    expect(await open('review', GENERAL, token)).toBe(200);
  });

  it('a joined batch still answers 409 for an image that became held', async () => {
    const token = (await signIn('review', GENERAL))!;
    getBatchMedia.mockResolvedValue({
      imageId: 101,
      url: 'k',
      type: 'image',
      mimeType: null,
      held: true,
    });
    expect(await open('review', GENERAL_2, token)).toBe(409);
    expect(streamStoredMedia).not.toHaveBeenCalled();
  });

  it('sign out ends the session on the server, not just the cookie, with no web session', async () => {
    const token = (await signIn('review', GENERAL))!;
    // Through the hook, as the phone sends it: the review cookie and nothing else.
    const url = new URL(`${ORIGIN}/api/review-media/auth/signout`);
    const event = {
      url,
      request: new Request(url, {
        method: 'POST',
        headers: { cookie: `${COOKIE.review}=${token}` },
      }),
      locals: {},
      route: { id: '/api/review-media/auth/signout' },
    };
    const resolve = vi.fn(async () =>
      signout.POST({
        cookies: { get: (n: string) => (n === COOKIE.review ? token : undefined) },
      } as never)
    );
    const res = await handle({ event, resolve } as never);
    expect(resolve).toHaveBeenCalled();
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await open('review', GENERAL, token)).toBe(401);
  });

  it('a failed sign out keeps the cookie, so the sheet can try again', async () => {
    const token = (await signIn('review', GENERAL))!;
    redis.del.mockRejectedValueOnce(new Error('down'));
    const res = await signout.POST({
      cookies: { get: (n: string) => (n === COOKIE.review ? token : undefined) },
    } as never);
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
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
    scannerHoldsImage.mockResolvedValueOnce(true);
    getBatchMedia.mockResolvedValue({
      imageId: 101,
      url: 'k',
      type: 'image',
      mimeType: null,
      held: false,
    });
    const late = await item('review', GENERAL, '0', reviewLocals([GENERAL_HASH]));
    expect(late.status).toBe(409);
    expect(streamStoredMedia).not.toHaveBeenCalled();
  });

  // Ruled 2026-11-14: a held batch serves all of its images to its viewer, clean ones included.
  // The tier is fixed at mint, so refusing a clean one leaves a gap nobody can close.
  it('a mixed undeclared held batch serves its clean image on the held route, audited', async () => {
    getBatchMedia.mockImplementation(async (_batch: unknown, n: number) => ({
      imageId: 101 + n,
      url: 'k',
      type: 'image',
      mimeType: null,
      held: n === 0,
    }));
    expect((await item('held', HELD, '0', heldLocals([HELD_HASH]))).status).toBe(200);
    expect((await item('held', HELD, '1', heldLocals([HELD_HASH]))).status).toBe(200);
    expect(insertModActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: 'heldMedia:view',
        entityId: 102,
        credential: 'sheet',
        review: { batchHash: HELD_HASH, tier: 'held', declared: false },
      })
    );
    // The same clean image in a general batch serves on the general route only.
    expect((await item('review', GENERAL, '1', reviewLocals([GENERAL_HASH]))).status).toBe(200);
    expect((await item('held', GENERAL, '1', heldLocals([GENERAL_HASH]))).status).toBe(404);
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
