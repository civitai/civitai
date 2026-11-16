import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `blocks.persistUploadedGenerationSource` — the server half of a picked generation source
 * (`useImageUpload({ purpose: 'generationSource' })` and a single `OPEN_MEDIA_UPLOAD` image) while
 * `app-block-source-scanned-rows` is on. These cases pin the procedure's own chain: the preamble
 * (`ai:write:budgeted`, viewer, session = subject, runtime flag), the identity
 * it hands the service (from the TOKEN, never the body), the per-user 60/h `rateLimit` middleware,
 * and the bounds it SHARES with `blocks.persistGenerationSource`: the per-user generation-source
 * bucket and the 2-in-flight cap, driven through the real limiters on an in-memory store.
 *
 * The service is a mock here; what it does with the url is driven against real SQL and the real
 * generation gate in `block-generation-source.upload.behavior.test.ts`.
 */

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  parseSubject: vi.fn(),
  appBlocksEnabled: vi.fn(),
  sessionUser: vi.fn(),
  persistUploaded: vi.fn(),
  persistOutput: vi.fn(),
  rateLimitApplied: [] as unknown[],
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseSubjectUserId: (...a: unknown[]) => h.parseSubject(...a) };
});
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => h.appBlocksEnabled(...a),
  isAppBlocksAuthorEnabled: vi.fn(),
  isAppBlocksPostCreationEnabled: vi.fn(),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => h.sessionUser(...a) },
}));
vi.mock('~/server/services/blocks/block-generation-source.service', () => ({
  persistUploadedGenerationSource: (...a: unknown[]) => h.persistUploaded(...a),
  persistBlockGenerationSource: (...a: unknown[]) => h.persistOutput(...a),
}));
// `rateLimit` transitively evaluates a top-level `Prisma.validator(...)`, which cannot run here,
// so it is replaced by one that RECORDS the options of every limiter a called procedure ran.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return {
    rateLimit: (opts: unknown) =>
      middleware(({ next }) => {
        h.rateLimitApplied.push(opts);
        return next();
      }),
  };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const VIEWER_ID = 42;
const OTHER_USER_ID = 7;
const BLOB_URL =
  'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x&exp=2030-01-01T00:00:00Z';

function claims(over: Record<string, unknown> = {}) {
  return {
    sub: `user:${VIEWER_ID}`,
    scopes: ['ai:write:budgeted'],
    appId: 'appblk-alpha',
    appBlockId: 'apb_alpha',
    blockInstanceId: 'page_apb_alpha',
    blockId: 'my-app',
    maxBrowsingLevel: 1,
    ctx: { slotId: 'page', entityType: 'none' },
    ...over,
  };
}

function ctx(user: { id: number; isModerator?: boolean } = { id: VIEWER_ID }) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    ip: '203.0.113.9',
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: { post: vi.fn(async () => undefined) },
  };
}

const call = (input: Record<string, unknown> = {}, c = ctx()) =>
  blocksRouter.createCaller(c as never).persistUploadedGenerationSource({
    blockToken: 'tok',
    url: BLOB_URL,
    ...input,
  } as never);

const callOutput = (c = ctx()) =>
  blocksRouter.createCaller(c as never).persistGenerationSource({
    blockToken: 'tok',
    workflowId: 'wf_1',
    imageIndex: 0,
  } as never);

const RESULT = {
  url: 'https://image.civitai.com/x/k/original=true/k.jpeg',
  width: 512,
  height: 768,
  imageId: 9001,
  ready: true,
};

/** An in-memory stand-in for the counter and sorted-set commands the two limiters use. */
function installStore() {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const sets = new Map<string, Map<string, number>>();
  const set = (k: string) => {
    let s = sets.get(k);
    if (!s) sets.set(k, (s = new Map()));
    return s;
  };
  const r = redisMock.redis;
  r.incrBy.mockImplementation((async (k: string, by: number) => {
    const n = (counters.get(k) ?? 0) + by;
    counters.set(k, n);
    return n;
  }) as never);
  r.expire.mockImplementation((async (k: string, s: number) => {
    ttls.set(k, s);
    return true;
  }) as never);
  r.ttl.mockImplementation((async (k: string) => ttls.get(k) ?? -1) as never);
  r.zRemRangeByScore.mockImplementation((async (k: string, _min: string, max: number) => {
    for (const [m, score] of set(k)) if (score <= max) set(k).delete(m);
    return 0;
  }) as never);
  r.zAdd.mockImplementation((async (k: string, e: { score: number; value: string }) => {
    set(k).set(e.value, e.score);
    return 1;
  }) as never);
  r.zCard.mockImplementation((async (k: string) => set(k).size) as never);
  r.zRem.mockImplementation((async (k: string, m: string) => (set(k).delete(m) ? 1 : 0)) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  installStore();
  h.rateLimitApplied.length = 0;
  h.authorize.mockResolvedValue(claims());
  h.parseSubject.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.slice('user:'.length))
  );
  h.appBlocksEnabled.mockResolvedValue(true);
  h.sessionUser.mockImplementation(async (id: number) => ({ id }));
  h.persistUploaded.mockResolvedValue(RESULT);
  h.persistOutput.mockResolvedValue(RESULT);
});

describe('blocks.persistUploadedGenerationSource — the preamble', () => {
  it('hands the service the TOKEN’s viewer and app and the url, and returns its result unchanged', async () => {
    await expect(call()).resolves.toEqual(RESULT);
    expect(h.persistUploaded.mock.calls).toEqual([
      [{ userId: VIEWER_ID, appId: 'appblk-alpha', url: BLOB_URL }],
    ]);
  });

  it('never takes the app or viewer from the request body', async () => {
    await call({ appId: 'appblk-evil', userId: 1 });
    const arg = h.persistUploaded.mock.calls[0][0];
    expect([arg.appId, arg.userId]).toEqual(['appblk-alpha', VIEWER_ID]);
  });

  it.each([
    ['no scopes', []],
    ['only posts:write:self', ['posts:write:self']],
  ])(
    '🔴 refuses a token without ai:write:budgeted (%s) FORBIDDEN, and persists nothing',
    async (_label, scopes) => {
      h.authorize.mockResolvedValue(claims({ scopes }));
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'block lacks ai:write:budgeted scope',
      });
      expect(h.persistUploaded).not.toHaveBeenCalled();
      expect(h.persistOutput).not.toHaveBeenCalled();
    }
  );

  it('applies the per-user 60-per-hour rateLimit to THIS procedure', async () => {
    await call();
    expect(h.rateLimitApplied).toEqual([expect.objectContaining({ limit: 60, period: 3600 })]);
  });

  it.each([
    [
      'an anonymous token subject',
      () => h.authorize.mockResolvedValue(claims({ sub: 'anon' })),
      {
        code: 'UNAUTHORIZED',
        message: 'saving a generation source requires an authenticated viewer',
      },
    ],
    [
      'the runtime flag off for the token subject',
      () => h.appBlocksEnabled.mockResolvedValue(false),
      { code: 'UNAUTHORIZED', message: 'Apps are not enabled' },
    ],
    [
      'a token the bridge guard refuses',
      () =>
        h.authorize.mockRejectedValue(
          Object.assign(new Error('block instance revoked'), { code: 'FORBIDDEN' })
        ),
      { message: 'block instance revoked' },
    ],
  ])('refuses %s, and never reaches the service', async (_label, arrange, expected) => {
    arrange();
    await expect(call()).rejects.toMatchObject(expected);
    expect(h.persistUploaded).not.toHaveBeenCalled();
  });

  it('🔴 refuses a session that is not the token subject, and never reaches the service', async () => {
    await expect(call({}, ctx({ id: OTHER_USER_ID }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this app session belongs to a different account; reload the page to continue',
    });
    expect(h.persistUploaded).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty url', { url: '' }],
    ['a url past 2048 characters', { url: `${BLOB_URL}&p=${'a'.repeat(2048)}` }],
    ['a non-string url', { url: 7 }],
  ])('rejects %s at the schema', async (_label, input) => {
    await expect(call(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.persistUploaded).not.toHaveBeenCalled();
  });
});

describe('blocks.persistUploadedGenerationSource — bounds shared with persistGenerationSource', () => {
  const moderator = (id = VIEWER_ID) => ctx({ id, isModerator: true });

  it('🔴 one hourly bucket per user across BOTH procedures: the 61st save is refused', async () => {
    for (let i = 0; i < 30; i++) await expect(call({}, moderator())).resolves.toEqual(RESULT);
    for (let i = 0; i < 30; i++) await expect(callOutput(moderator())).resolves.toEqual(RESULT);
    await expect(call({}, moderator())).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many generation sources saved — slow down.',
    });
    expect(h.persistUploaded).toHaveBeenCalledTimes(30);
  });

  it('the bucket is per user: another user is not refused', async () => {
    for (let i = 0; i < 61; i++) await call({}, moderator()).catch(() => undefined);
    h.authorize.mockImplementation(async () => claims({ sub: `user:${OTHER_USER_ID}` }));
    await expect(call({}, moderator(OTHER_USER_ID))).resolves.toEqual(RESULT);
  });

  it('🔴 a third concurrent save is refused while two are in flight, whichever procedure holds them', async () => {
    const finish: Array<() => void> = [];
    h.persistUploaded.mockImplementation(
      () => new Promise((resolve) => finish.push(() => resolve(RESULT)))
    );
    h.persistOutput.mockImplementation(
      () => new Promise((resolve) => finish.push(() => resolve(RESULT)))
    );
    const first = call({}, moderator());
    await vi.waitFor(() => expect(h.persistUploaded).toHaveBeenCalledTimes(1));
    const second = callOutput(moderator());
    await vi.waitFor(() => expect(h.persistOutput).toHaveBeenCalledTimes(1));

    await expect(call({}, moderator())).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'A generation source is already being saved — wait for it to finish.',
    });
    expect(h.persistUploaded).toHaveBeenCalledTimes(1);

    finish.splice(0).forEach((f) => f());
    await expect(first).resolves.toEqual(RESULT);
    await expect(second).resolves.toEqual(RESULT);
  });
});
