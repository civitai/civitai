import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * Handler-level coverage for GET /api/v1/blocks/submissions — the token-auth,
 * SELF-SCOPED submission-status read that unblocks `civitai app status`.
 *
 * Asserts the security-sensitive invariants:
 *   - auth: missing/invalid key → 401; un-scoped OAuth → 403; scoped OAuth
 *     (AppBlocksSubmit) → allowed.
 *   - gate: non-mod → 403; banned → 403; flag off → 503 (dark).
 *   - SELF-SCOPING (the crux): the DB query is ALWAYS filtered to the caller's
 *     `submittedByUserId`; user A cannot read user B's rows by listing OR by id.
 *   - happy path: returns the caller's rows newest-first with the safe shape
 *     (+ liveUrl only when serving), no-store header.
 *   - single-item: `?id=` not-owned → 404 (no ownership oracle).
 *   - rate-limit exceeded → 429; malformed limiter / redis incident → 503.
 *   - 405 for non-GET.
 */

function createMocks({
  method = 'GET',
  headers = {},
  query = {},
}: {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}) {
  const req = {
    method,
    headers,
    query,
    socket: { remoteAddress: '203.0.113.7' },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown = undefined;
  const responseHeaders: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(key: string, value: string) {
      responseHeaders[key] = value;
    },
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _getHeaders: () => responseHeaders,
  };
  return { req, res };
}

const {
  mockGetSession,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockFindMany,
  mockFindFirst,
  mockQueryRaw,
  mockSysRedis,
  mockMultiIncr,
} = vi.hoisted(() => {
  const mockMultiIncr = {
    value: 1,
    malformedExec: false as unknown[] | null | false,
    throwExec: false,
  };
  const multiFactory = () => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockImplementation(async () => {
      if (mockMultiIncr.throwExec) throw new Error('redis down');
      return mockMultiIncr.malformedExec !== false
        ? mockMultiIncr.malformedExec
        : ['OK', mockMultiIncr.value];
    }),
  });
  return {
    mockGetSession: vi.fn(),
    mockIsAppBlocksEnabled: vi.fn(),
    mockIsAppBlocksAuthorEnabled: vi.fn(),
    mockFindMany: vi.fn(),
    mockFindFirst: vi.fn(),
    mockQueryRaw: vi.fn(),
    mockSysRedis: {
      multi: vi.fn(multiFactory),
      ttl: vi.fn().mockResolvedValue(60),
      expire: vi.fn().mockResolvedValue(1),
    },
    mockMultiIncr,
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: {
    appBlockPublishRequest: { findMany: mockFindMany, findFirst: mockFindFirst },
    // The `actions_run_*` columns are no-type, so they are read with raw SQL.
    $queryRaw: mockQueryRaw,
  },
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { SUBMISSIONS_RATE_LIMIT: 'system:blocks:submissions-rate-limit' } },
}));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));

const { mockFliptVariant } = vi.hoisted(() => ({
  mockFliptVariant: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { BEARER_SCOPE_TIGHTEN: 'bearer-scope-tighten' },
  getFliptVariant: mockFliptVariant,
}));

import handler from '~/pages/api/v1/blocks/submissions';
import { Prisma } from '@prisma/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER_ID = 7;

// Personal-access (user-type) key + moderator.
const MOD_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 42,
  subject: { type: 'apiKey', id: 42 },
  tokenScope: TokenScope.Full,
};
const NONMOD_SESSION = {
  user: { id: 8, isModerator: false },
  apiKeyId: 43,
  subject: { type: 'apiKey', id: 43 },
  tokenScope: TokenScope.Full,
};
// An OAuth-client token WITHOUT the AppBlocksSubmit bit (TokenScope.Full excludes it).
const OAUTH_UNSCOPED_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 99,
  subject: { type: 'oauth', id: 'client_abc' },
  tokenScope: TokenScope.Full,
};
// An OAuth-client token that carries the dedicated AppBlocksSubmit bit (the
// first-party civitai-cli client).
const OAUTH_SCOPED_SESSION = {
  user: { id: OWNER_ID, isModerator: true },
  apiKeyId: 100,
  subject: { type: 'oauth', id: 'civitai-cli' },
  tokenScope: TokenScope.UserRead | TokenScope.AppBlocksSubmit,
};

function dbRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pubreq_01',
    appBlockId: 'apb_abc',
    slug: 'my-page-app',
    version: '0.1.0',
    status: 'approved',
    rejectionReason: null,
    approvalNotes: null,
    deployState: 'live',
    deployDetail: null,
    deployUpdatedAt: new Date('2026-06-22T00:00:00Z'),
    // #4059: the DEFAULT fixture is a LEGACY row — submitted before provenance
    // existed, so both columns are NULL (unknown). The happy-path `toEqual`
    // below therefore doubles as the legacy-shape assertion: a legacy row must
    // shape to `null`, not be dropped from the payload and not be coerced.
    sourceCommit: null,
    sourceDirty: null,
    submittedAt: new Date('2026-06-20T00:00:00Z'),
    reviewedAt: new Date('2026-06-21T00:00:00Z'),
    updatedAt: new Date('2026-06-22T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiIncr.value = 1;
  mockMultiIncr.malformedExec = false;
  mockMultiIncr.throwExec = false;
  mockSysRedis.ttl.mockResolvedValue(60);
  mockSysRedis.expire.mockResolvedValue(1);
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  // Author capability defaults to the mod-floor (mirrors isAppBlocksAuthorEnabled
  // when the app-blocks-author Flipt flag is absent): mods pass, non-mods don't.
  mockIsAppBlocksAuthorEnabled.mockImplementation(
    async (opts?: { user?: { isModerator?: boolean } }) => !!opts?.user?.isModerator
  );
  mockFindMany.mockResolvedValue([dbRow()]);
  mockFindFirst.mockResolvedValue(dbRow());
  // No Actions run recorded for any row unless a test says otherwise.
  mockQueryRaw.mockResolvedValue([]);
});

function authGet(query: Record<string, string> = {}) {
  return createMocks({ headers: { authorization: 'Bearer personal-key' }, query });
}

describe('GET /api/v1/blocks/submissions', () => {
  it('405 for non-GET', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
  });

  it('401 when Authorization header is missing', async () => {
    const { req, res } = createMocks({});
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('401 when the bearer key does not resolve to a session', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('403 when the OAuth token lacks the AppBlocksSubmit scope', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_UNSCOPED_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { message: string }).message).toContain('submit scope');
    // Rejected before flag / db — no leak.
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('allows a scoped OAuth token (AppBlocksSubmit) — same token that submitted can read', async () => {
    mockGetSession.mockResolvedValueOnce(OAUTH_SCOPED_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { submittedByUserId: OWNER_ID } })
    );
  });

  it('403 when the resolved user is NOT a moderator (and not a cohort author)', async () => {
    mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('accepts an author-capable NON-MOD (cohort widening): passes the authz line to the query', async () => {
    mockGetSession.mockResolvedValueOnce(NONMOD_SESSION);
    mockIsAppBlocksAuthorEnabled.mockResolvedValueOnce(true);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).not.toBe(403);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('403 when the mod is banned', async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: OWNER_ID, isModerator: true, bannedAt: new Date() },
      apiKeyId: 44,
      subject: { type: 'apiKey', id: 44 },
    });
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('503 (dark) when the App Blocks flag is OFF for the user', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockIsAppBlocksEnabled.mockResolvedValueOnce(false);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('SELF-SCOPING: list query is ALWAYS filtered to the caller submittedByUserId', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const arg = mockFindMany.mock.calls[0][0];
    // The ownership-deciding clause is present and equal to the caller.
    expect(arg.where.submittedByUserId).toBe(OWNER_ID);
    // Newest-first, bounded.
    expect(arg.orderBy).toEqual({ submittedAt: 'desc' });
    expect(arg.take).toBe(100);
  });

  it('CROSS-USER ISOLATION: user A cannot read user B by listing — query filters on A only', async () => {
    // User A authenticates. Even though the DB mock would happily return any
    // rows, the handler must scope the WHERE to A's id, so B's rows are
    // unreachable. We assert on the query the handler issues (the real DB
    // enforces the filter).
    const USER_A = { ...MOD_SESSION, user: { id: 101, isModerator: true } };
    mockGetSession.mockResolvedValueOnce(USER_A);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { submittedByUserId: 101 } })
    );
    // No way for A to pass a userId that widens the scope (no such param exists).
  });

  it('CROSS-USER ISOLATION: ?id= for a not-owned submission → 404 (no ownership oracle)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    // Self-scoped findFirst finds nothing because the id belongs to user B.
    mockFindFirst.mockResolvedValueOnce(null);
    const { req, res } = authGet({ id: 'pubreq_owned_by_B' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    // The findFirst query must still carry the self-scope clause.
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { submittedByUserId: OWNER_ID, id: 'pubreq_owned_by_B' },
      })
    );
  });

  it('happy path: lists the caller rows with the safe shape + no-store header', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()['Cache-Control']).toBe('no-store');
    const out = res._getJSONData() as { submissions: Array<Record<string, unknown>> };
    expect(Array.isArray(out.submissions)).toBe(true);
    const s = out.submissions[0];
    expect(s).toEqual({
      id: 'pubreq_01',
      blockId: 'my-page-app',
      appBlockId: 'apb_abc',
      version: '0.1.0',
      status: 'approved',
      rejectionReason: null,
      approvalNotes: null,
      deployState: 'live',
      deployDetail: null,
      deployUpdatedAt: '2026-06-22T00:00:00.000Z',
      // #4059 — a legacy (pre-provenance) row: both NULL, both PRESENT.
      sourceCommit: null,
      sourceDirty: null,
      submittedAt: '2026-06-20T00:00:00.000Z',
      reviewedAt: '2026-06-21T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:00.000Z',
      createdAt: '2026-06-20T00:00:00.000Z',
      liveUrl: 'https://my-page-app.civit.ai/',
      // No Actions run recorded: present as a key, and null.
      actionsRunSource: null,
    });
    // No internal-only columns leaked.
    expect(s).not.toHaveProperty('bundleKey');
    expect(s).not.toHaveProperty('forgejoCommitSha');
    expect(s).not.toHaveProperty('submittedByUserId');
    expect(s).not.toHaveProperty('manifest');
  });

  it('liveUrl is null when the row is approved but not yet serving (deployState building)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockFindMany.mockResolvedValueOnce([dbRow({ status: 'approved', deployState: 'building' })]);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const out = res._getJSONData() as { submissions: Array<{ liveUrl: string | null }> };
    expect(out.submissions[0].liveUrl).toBeNull();
  });

  /**
   * 🔴 `liveUrl` and the TWO opposite meanings of a null deployState.
   *
   * This is the surface `civitai app status` reads. Handing it a working-looking
   * URL for a STRANDED approval (the build never fired, so deploy_state stayed
   * null) re-creates on the CLI exactly the invisible failure this feature exists
   * to remove. But a LEGACY row — approved before deploy-state tracking existed —
   * has the same null and genuinely IS serving, so it must keep its URL.
   */
  it('liveUrl is null for a STRANDED approval (tracked era, build never fired)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockFindMany.mockResolvedValueOnce([
      dbRow({
        status: 'approved',
        deployState: null,
        // Approved AFTER deploy-state tracking began, and nothing ever transitioned.
        reviewedAt: new Date('2026-06-21T00:00:00Z'),
        deployUpdatedAt: null,
      }),
    ]);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const out = res._getJSONData() as { submissions: Array<{ liveUrl: string | null }> };
    expect(out.submissions[0].liveUrl).toBeNull();
  });

  it('liveUrl is PRESERVED for a LEGACY approval predating deploy-state tracking', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockFindMany.mockResolvedValueOnce([
      dbRow({
        status: 'approved',
        deployState: null,
        // Approved before the deploy_state column existed: null is expected here
        // and says nothing about whether the app deployed. It did.
        reviewedAt: new Date('2026-05-01T00:00:00Z'),
        deployUpdatedAt: null,
      }),
    ]);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    const out = res._getJSONData() as { submissions: Array<{ liveUrl: string | null }> };
    expect(out.submissions[0].liveUrl).toBe('https://my-page-app.civit.ai/');
  });

  it('liveUrl is PRESERVED for a null-state row that DID record a transition', async () => {
    // A recorded deployUpdatedAt proves the lifecycle ran at some point, so this
    // is not the stranded signature whatever the approval date.
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockFindMany.mockResolvedValueOnce([
      dbRow({
        status: 'approved',
        deployState: null,
        reviewedAt: new Date('2026-06-21T00:00:00Z'),
        deployUpdatedAt: new Date('2026-06-22T00:00:00Z'),
      }),
    ]);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    const out = res._getJSONData() as { submissions: Array<{ liveUrl: string | null }> };
    expect(out.submissions[0].liveUrl).toBe('https://my-page-app.civit.ai/');
  });

  it('liveUrl is null for a FAILED build', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockFindMany.mockResolvedValueOnce([dbRow({ status: 'approved', deployState: 'failed' })]);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    const out = res._getJSONData() as { submissions: Array<{ liveUrl: string | null }> };
    expect(out.submissions[0].liveUrl).toBeNull();
  });

  it('liveUrl is null for a pending (not-approved) submission', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockFindMany.mockResolvedValueOnce([
      dbRow({ status: 'pending', deployState: null, reviewedAt: null }),
    ]);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    const out = res._getJSONData() as { submissions: Array<{ liveUrl: string | null }> };
    expect(out.submissions[0].liveUrl).toBeNull();
  });

  it('single-item by ?id= returns { submission } with the safe shape', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authGet({ id: 'pubreq_01' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const out = res._getJSONData() as { submission: { id: string; blockId: string } };
    expect(out.submission.id).toBe('pubreq_01');
    expect(out.submission.blockId).toBe('my-page-app');
  });

  it('?blockId= narrows the self-scoped list to one app (slug filter)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    const { req, res } = authGet({ blockId: 'my-page-app' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { submittedByUserId: OWNER_ID, slug: 'my-page-app' },
      })
    );
  });

  // ---------------------------------------------------------------------------
  // #4059 build provenance on the READ path. This is the projection
  // `civitai app status` reads, so a value that is stored but not returned is
  // the same inert feature as a value that was never stored.
  // ---------------------------------------------------------------------------
  describe('#4059 source provenance', () => {
    const SHA = '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3';

    it('SURFACES a populated sourceCommit + sourceDirty:true', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockFindMany.mockResolvedValueOnce([dbRow({ sourceCommit: SHA, sourceDirty: true })]);
      const { req, res } = authGet();
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const out = res._getJSONData() as {
        submissions: Array<{ sourceCommit: string | null; sourceDirty: boolean | null }>;
      };
      expect(out.submissions[0].sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
      expect(out.submissions[0].sourceDirty).toBe(true);
    });

    /**
     * 🔴 `null` (UNKNOWN) and `false` (the client asserted CLEAN) are DIFFERENT
     * answers and must stay distinguishable end to end. A `?? false` anywhere on
     * this path collapses them and turns "nobody looked" into "someone looked and
     * it was clean" for every pre-#4059 row — a fabricated fact, and precisely
     * the opposite of what this feature exists to establish. These two tests are
     * a pair: neither alone can see the collapse.
     */
    it('a legacy row keeps sourceDirty:NULL — not dropped, not coerced to false', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockFindMany.mockResolvedValueOnce([dbRow({ sourceCommit: null, sourceDirty: null })]);
      const { req, res } = authGet();
      await handler(req as never, res as never);
      const s = (res._getJSONData() as { submissions: Array<Record<string, unknown>> })
        .submissions[0];
      // Present as a key (not dropped) AND null (not coerced).
      expect('sourceDirty' in s).toBe(true);
      expect('sourceCommit' in s).toBe(true);
      expect(s.sourceDirty).toBeNull();
      expect(s.sourceCommit).toBeNull();
      expect(s.sourceDirty).not.toBe(false);
    });

    it('a KNOWN-CLEAN row reads sourceDirty:false — and false is not null', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockFindMany.mockResolvedValueOnce([dbRow({ sourceCommit: SHA, sourceDirty: false })]);
      const { req, res } = authGet();
      await handler(req as never, res as never);
      const s = (res._getJSONData() as { submissions: Array<Record<string, unknown>> })
        .submissions[0];
      expect(s.sourceDirty).toBe(false);
      expect(s.sourceDirty).not.toBeNull();
    });

    it('the ?id= single-item read surfaces provenance too', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockFindFirst.mockResolvedValueOnce(dbRow({ sourceCommit: SHA, sourceDirty: false }));
      const { req, res } = authGet({ id: 'pubreq_01' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const out = res._getJSONData() as {
        submission: { sourceCommit: string | null; sourceDirty: boolean | null };
      };
      expect(out.submission.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
      expect(out.submission.sourceDirty).toBe(false);
    });

    it('the SELECT projection asks the DB for both columns', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      const { req, res } = authGet();
      await handler(req as never, res as never);
      // Without this the columns are never fetched, so shapeRow reads
      // `undefined` and the keys vanish from the JSON — stored but invisible.
      const call = mockFindMany.mock.calls[0][0] as { select: Record<string, unknown> };
      expect(call.select.sourceCommit).toBe(true);
      expect(call.select.sourceDirty).toBe(true);
      // The SERVER-side forgejo sha stays OFF this projection: different thing,
      // internal-only, and never the author's commit.
      expect(call.select.forgejoCommitSha).toBeUndefined();
    });

    it('does NOT leak forgejoCommitSha alongside the client claim', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockFindMany.mockResolvedValueOnce([
        dbRow({ sourceCommit: SHA, sourceDirty: true, forgejoCommitSha: 'server-side-sha' }),
      ]);
      const { req, res } = authGet();
      await handler(req as never, res as never);
      const s = (res._getJSONData() as { submissions: Array<Record<string, unknown>> })
        .submissions[0];
      expect(s).not.toHaveProperty('forgejoCommitSha');
      expect(s.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    });
  });

  // ---------------------------------------------------------------------------
  // The GitHub Actions run that sent the submit (`actions_run_*`), for
  // `civitai app status`. Shown under the SAME rule as the public store page:
  // public repositories and tag refs only.
  // ---------------------------------------------------------------------------
  describe('actionsRunSource', () => {
    const RUN_SHA = '177445b0c9d2e8f1a3b5c7d9e1f2a4b6c8d0e2f4';
    const CLAIMED_SHA = '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3';
    function runRow(over: Record<string, unknown> = {}) {
      return {
        id: 'pubreq_01',
        repository: 'harbor-tools/knot-tier',
        repositoryId: '880011',
        repositoryOwnerId: '770022',
        sha: RUN_SHA,
        ref: 'refs/tags/v0.9.1',
        workflowRef: 'harbor-tools/knot-tier/.github/workflows/release.yml@refs/tags/v0.9.1',
        repositoryVisibility: 'public',
        runId: '9900112233',
        ...over,
      };
    }

    it('returns a recorded public run as { repository, tag, sha }, only on its own row', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockFindMany.mockResolvedValueOnce([
        dbRow({ id: 'pubreq_01', sourceCommit: CLAIMED_SHA, sourceDirty: false }),
        dbRow({ id: 'pubreq_02', version: '0.0.9' }),
      ]);
      mockQueryRaw.mockResolvedValueOnce([runRow()]);
      const { req, res } = authGet();
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const out = res._getJSONData() as { submissions: Array<Record<string, unknown>> };
      expect(out.submissions[0].actionsRunSource).toEqual({
        repository: 'harbor-tools/knot-tier',
        tag: 'v0.9.1',
        sha: '177445b0c9d2e8f1a3b5c7d9e1f2a4b6c8d0e2f4',
      });
      // A different trust level from the client claim: neither replaces the other.
      expect(out.submissions[0].sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
      // The row with no recorded run gets null, not its neighbour's run.
      expect(out.submissions[1].actionsRunSource).toBeNull();
      // The read is scoped to the rows this response returns.
      const [strings, ...values] = mockQueryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[]
      ];
      expect(Prisma.sql(strings, ...(values as Prisma.Sql[])).values).toEqual([
        'pubreq_01',
        'pubreq_02',
      ]);
    });

    it('the ?id= single-item read returns the recorded public run too', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockQueryRaw.mockResolvedValueOnce([runRow()]);
      const { req, res } = authGet({ id: 'pubreq_01' });
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const out = res._getJSONData() as { submission: Record<string, unknown> };
      expect(out.submission.actionsRunSource).toEqual({
        repository: 'harbor-tools/knot-tier',
        tag: 'v0.9.1',
        sha: '177445b0c9d2e8f1a3b5c7d9e1f2a4b6c8d0e2f4',
      });
    });

    it('a private or internal repository run is null, as on the public store page', async () => {
      for (const repositoryVisibility of ['private', 'internal']) {
        mockGetSession.mockResolvedValueOnce(MOD_SESSION);
        mockQueryRaw.mockResolvedValueOnce([runRow({ repositoryVisibility })]);
        const { req, res } = authGet();
        await handler(req as never, res as never);
        expect(res._getStatusCode()).toBe(200);
        const out = res._getJSONData() as { submissions: Array<Record<string, unknown>> };
        expect(out.submissions[0].actionsRunSource).toBeNull();
      }
    });

    it('a run whose stored ref is not a tag, or whose sha is malformed, is null', async () => {
      for (const over of [{ ref: 'refs/heads/main' }, { sha: 'not-a-sha' }]) {
        mockGetSession.mockResolvedValueOnce(MOD_SESSION);
        mockQueryRaw.mockResolvedValueOnce([runRow(over)]);
        const { req, res } = authGet();
        await handler(req as never, res as never);
        expect(res._getStatusCode()).toBe(200);
        const out = res._getJSONData() as { submissions: Array<Record<string, unknown>> };
        expect(out.submissions[0].actionsRunSource).toBeNull();
      }
    });

    it('a failed run read (columns not applied yet) still answers 200 with null', async () => {
      mockGetSession.mockResolvedValueOnce(MOD_SESSION);
      mockQueryRaw.mockRejectedValueOnce(
        Object.assign(new Error('column "actions_run_sha" does not exist'), {
          code: 'P2010',
          meta: { code: '42703' },
        })
      );
      const { req, res } = authGet();
      await handler(req as never, res as never);
      expect(res._getStatusCode()).toBe(200);
      const out = res._getJSONData() as { submissions: Array<Record<string, unknown>> };
      expect(out.submissions[0].actionsRunSource).toBeNull();
    });
  });

  it('429 when the per-user rate limit is exceeded', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 61; // > RATE_LIMIT.max (60)
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeaders()['Retry-After']).toBeDefined();
    // An abuse limit: the house meta names it and the wait, and carries no counts (the
    // route's own top-level fields are kept as it always sent them).
    expect(res._getJSONData()).toMatchObject({
      message: 'Rate limit exceeded',
      code: 'TOO_MANY_REQUESTS',
      rateLimit: { retryAfterSeconds: 60, id: 'apps.listing-submissions', kind: 'abuse' },
    });
    expect(Object.keys((res._getJSONData() as { rateLimit: object }).rateLimit).sort()).toEqual([
      'id',
      'kind',
      'retryAfterSeconds',
      'retryAt',
    ]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('503 (fail closed) when the rate-limit exec() is malformed', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.malformedExec = null;
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('503 (fail closed) when the rate-limit exec() THROWS (redis incident)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.throwExec = true;
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(503);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('self-heals a TTL-less rate-limit key (re-arms expiry when ttl < 0)', async () => {
    mockGetSession.mockResolvedValueOnce(MOD_SESSION);
    mockMultiIncr.value = 2; // not first hit → self-heal branch runs
    mockSysRedis.ttl.mockResolvedValueOnce(-1); // key exists but lost its TTL
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSysRedis.expire).toHaveBeenCalledWith(
      'system:blocks:submissions-rate-limit:u:7',
      60
    );
  });
});

describe('/api/v1/blocks/submissions under bearer-scope-tighten', () => {
  beforeEach(() => {
    mockFliptVariant.mockReset();
  });

  // A personal key narrower than Full.
  const NARROW_KEY_SESSION = {
    ...MOD_SESSION,
    apiKeyType: 'User',
    tokenScope: TokenScope.UserRead | TokenScope.ModelsRead,
  };
  const FULL_KEY_SESSION = { ...MOD_SESSION, apiKeyType: 'User' };

  it('enforce: 403s a narrow personal key before any other work', async () => {
    mockFliptVariant.mockResolvedValue('enforce');
    mockGetSession.mockResolvedValueOnce(NARROW_KEY_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { message: string }).message).toContain('Full Access');
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockFliptVariant).toHaveBeenCalledWith('bearer-scope-tighten');
  });

  it('log: lets a narrow personal key through and logs it', async () => {
    mockFliptVariant.mockResolvedValue('log');
    mockGetSession.mockResolvedValueOnce(NARROW_KEY_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindMany).toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'bearer-scope-refused',
        payload: expect.objectContaining({
          mode: 'log',
          route: '/api/v1/blocks/submissions',
          credentialKind: 'apiKey',
          apiKeyId: NARROW_KEY_SESSION.apiKeyId,
        }),
      })
    );
  });

  it('off (any unknown variant): lets a narrow personal key through without logging', async () => {
    mockFliptVariant.mockResolvedValue('bogus');
    mockGetSession.mockResolvedValueOnce(NARROW_KEY_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bearer-scope-refused' })
    );
  });

  it('off when the flag read fails', async () => {
    mockFliptVariant.mockRejectedValue(new Error('flipt down'));
    mockGetSession.mockResolvedValueOnce(NARROW_KEY_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
  });

  it('enforce: a Full Access personal key passes without reading the flag', async () => {
    mockFliptVariant.mockResolvedValue('enforce');
    mockGetSession.mockResolvedValueOnce(FULL_KEY_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockFliptVariant).not.toHaveBeenCalled();
  });

  it('enforce: an OAuth token carrying AppBlocksSubmit passes', async () => {
    mockFliptVariant.mockResolvedValue('enforce');
    mockGetSession.mockResolvedValueOnce(OAUTH_SCOPED_SESSION);
    const { req, res } = authGet();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
  });
});
