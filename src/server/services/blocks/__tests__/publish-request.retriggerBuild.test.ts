import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOY_PENDING_GRACE_MS,
  DEPLOY_STALE_AFTER_MS,
} from '~/shared/constants/app-block-deploy.constants';

/**
 * `retriggerBuild` — the recovery path for an APPROVED publish request whose build
 * never ran.
 *
 * WHY IT EXISTS: `approveRequest` writes `status='approved'` + `forgejo_commit_sha`
 * and only THEN calls `markRequestDeployState(...,'building')`. When `triggerBuild`
 * threw in between (a transient 502 from the build trigger, seen in production),
 * the approve was durable but `deploy_state` stayed NULL forever. `approveRequest`
 * is not idempotent, so the request was UNRECOVERABLE.
 *
 * Every guard below has a test for BOTH its passing and its failing branch. The
 * load-bearing one is (3): the sha comes from the DB, never the caller.
 *
 * 🔴 GUARD TESTS MUST BE INDEPENDENTLY KILLING. An earlier revision of this suite
 * asserted the sha guard with `NOT_RETRIGGERABLE` — the same code the SUPERSEDE
 * guard throws — while the fixture pinned `appBlock.currentVersionSha = SHA`. A
 * malformed `forgejoCommitSha` therefore tripped supersede too, and deleting the
 * `/^[0-9a-f]{40}$/` check left all 41 tests green. The fix is BOTH halves: the sha
 * guard has its own `INVALID_STORED_SHA` code, and the sha cases null out
 * `currentVersionSha` so no other guard can stand in for it. Verified by mutation:
 * deleting the sha check now fails these tests.
 */

const {
  mockDbRead,
  mockDbWriteFindUnique,
  mockUpdateMany,
  mockTriggerBuild,
  mockSetCommitStatus,
  mockRedis,
  limiter,
} = vi.hoisted(() => {
  const mockRedis = { nxResult: true, nxThrows: false, quotaAllowed: true };
  return {
    mockRedis,
    // The READ REPLICA. `retriggerBuild` must NOT consult it for any guard — it
    // is wired here precisely so a regression back to `dbRead` is detectable.
    mockDbRead: { appBlockPublishRequest: { findUnique: vi.fn() } },
    mockDbWriteFindUnique: vi.fn(),
    // `markRequestDeployState` lives in the module UNDER TEST, so it cannot be
    // mocked — assert on the DB write it performs instead. That is the stronger
    // assertion anyway: it pins the actual persisted row, not a call to a spy.
    mockUpdateMany: vi.fn(async () => ({ count: 1 })),
    mockTriggerBuild: vi.fn<(...a: any[]) => Promise<{ name: string }>>(async () => ({
      name: 'pipelinerun-1',
    })),
    mockSetCommitStatus: vi.fn(async () => undefined),
    limiter: {
      acquire: vi.fn(async () => mockRedis.nxResult),
      release: vi.fn(async () => undefined),
      quota: vi.fn(async () =>
        mockRedis.quotaAllowed
          ? ({ allowed: true } as const)
          : ({ allowed: false, retryAfterSeconds: 1800 } as const)
      ),
    },
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {
    appBlockPublishRequest: { findUnique: mockDbWriteFindUnique, updateMany: mockUpdateMany },
  },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('~/env/server', () => ({
  env: { FORGEJO_BASE_URL: 'https://forge.example', FORGEJO_ADMIN_TOKEN: 'tok' },
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: mockTriggerBuild,
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  setCommitStatus: mockSetCommitStatus,
  reviewRepoUrl: vi.fn(() => ''),
  repoCommitUrl: vi.fn(() => ''),
  listRepoTreeAtRef: vi.fn(),
  getBlobContent: vi.fn(),
  commitFiles: vi.fn(),
  createRepoFromTemplate: vi.fn(),
  ensurePushWebhook: vi.fn(),
}));
vi.mock('~/server/utils/blocks-retrigger-rate-limit', () => ({
  acquireRetriggerLock: limiter.acquire,
  releaseRetriggerLock: limiter.release,
  checkRetriggerModeratorQuota: limiter.quota,
}));

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const APB = 'apb_0123456789ABCDEFGHJKMNPQRS';
const REQ_ID = 'pubreq_1';
const MOD_ID = 7;

/** Older than the post-approval grace window — a genuinely stranded approval. */
const strandedReviewedAt = () => new Date(Date.now() - DEPLOY_STALE_AFTER_MS - 60_000);

/** An approved-but-STRANDED request: the exact production shape of defect B. */
function strandedRow(over: Record<string, unknown> = {}) {
  return {
    id: REQ_ID,
    status: 'approved',
    slug: 'my-app',
    appBlockId: APB,
    forgejoCommitSha: SHA,
    deployState: null,
    deployUpdatedAt: null,
    // `approveRequest` always stamps this; it is the anchor for the null-state
    // grace window, so the realistic fixture carries it.
    reviewedAt: strandedReviewedAt(),
    appBlock: { id: APB, currentVersionSha: SHA },
    ...over,
  };
}

async function callRetrigger(overrides: Record<string, unknown> = {}) {
  mockDbWriteFindUnique.mockResolvedValue(strandedRow(overrides));
  const { retriggerBuild } = await import('../publish-request.service');
  return retriggerBuild({ publishRequestId: REQ_ID, reviewerUserId: MOD_ID });
}

/** Assert the call rejects with a RetriggerBuildError carrying `code`. */
async function expectRejectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: 'RetriggerBuildError', code });
}

/** The deploy-lifecycle writes `markRequestDeployState` performed, flattened. */
function deployWrites(): Array<{
  slug: string;
  sha: string;
  state: string;
  detail: string | null;
}> {
  return mockUpdateMany.mock.calls.map((call) => {
    const arg = call[0] as {
      where: { slug: string; forgejoCommitSha: string };
      data: { deployState: string; deployDetail: string | null };
    };
    return {
      slug: arg.where.slug,
      sha: arg.where.forgejoCommitSha,
      state: arg.data.deployState,
      detail: arg.data.deployDetail,
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.nxResult = true;
  mockRedis.quotaAllowed = true;
  mockTriggerBuild.mockResolvedValue({ name: 'pipelinerun-1' });
});

describe('retriggerBuild — happy path', () => {
  it('fires the build with the DB sha and marks the request building', async () => {
    const result = await callRetrigger();

    expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
    expect(mockTriggerBuild).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'my-app', sha: SHA, appBlockId: APB })
    );
    expect(mockTriggerBuild.mock.calls[0][0].callbackUrl).toContain(
      '/api/internal/blocks/build-callback'
    );
    expect(deployWrites()).toEqual([
      {
        slug: 'my-app',
        sha: SHA,
        state: 'building',
        detail: expect.stringContaining(`moderator #${MOD_ID}`),
      },
    ]);
    expect(result).toEqual({ publishRequestId: REQ_ID, appBlockId: APB, forgejoCommitSha: SHA });
  });

  it('sets a pending commit status before triggering', async () => {
    await callRetrigger();
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: SHA, state: 'pending', context: 'civitai/build' })
    );
  });

  it('performs NONE of approveRequest side effects (no re-commit, no block mutation)', async () => {
    const forgejo = await import('~/server/services/blocks/forgejo.service');
    await callRetrigger();
    expect(vi.mocked(forgejo.commitFiles)).not.toHaveBeenCalled();
    expect(vi.mocked(forgejo.createRepoFromTemplate)).not.toHaveBeenCalled();
    expect(vi.mocked(forgejo.ensurePushWebhook)).not.toHaveBeenCalled();
  });

  it('allows a previously FAILED build', async () => {
    await expect(
      callRetrigger({ deployState: 'failed', deployUpdatedAt: new Date() })
    ).resolves.toMatchObject({ forgejoCommitSha: SHA });
    expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
  });
});

describe('retriggerBuild — guard 1: request must exist', () => {
  it('NOT_FOUND when the row does not exist', async () => {
    mockDbWriteFindUnique.mockResolvedValue(null);
    const { retriggerBuild } = await import('../publish-request.service');
    await expectRejectCode(
      retriggerBuild({ publishRequestId: 'nope', reviewerUserId: MOD_ID }),
      'NOT_FOUND'
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });
});

describe('retriggerBuild — guard 2: status must be approved', () => {
  it.each(['pending', 'rejected', 'withdrawn'])('refuses status=%s', async (status) => {
    await expectRejectCode(callRetrigger({ status }), 'NOT_RETRIGGERABLE');
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });
});

describe('retriggerBuild — guard 3: the sha comes from the DB, never the caller', () => {
  /**
   * Every case here nulls out `appBlock.currentVersionSha` so the SUPERSEDE guard
   * (5) — which a malformed sha would otherwise also trip — cannot be what rejects
   * the call. Combined with the guard's own `INVALID_STORED_SHA` code, these
   * assertions are killed by deleting the sha check and by nothing else.
   */
  const noBlockSha = { appBlock: { id: APB, currentVersionSha: null } };

  it('refuses a request with NO stored sha', async () => {
    await expectRejectCode(
      callRetrigger({ forgejoCommitSha: null, ...noBlockSha }),
      'INVALID_STORED_SHA'
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('refuses an empty stored sha', async () => {
    await expectRejectCode(
      callRetrigger({ forgejoCommitSha: '', ...noBlockSha }),
      'INVALID_STORED_SHA'
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'abc123'],
    ['too long', 'a'.repeat(41)],
    ['uppercase hex', 'A'.repeat(40)],
    ['non-hex', 'g'.repeat(40)],
    ['a git ref instead of a sha', 'refs/heads/main'],
    ['path traversal', '../'.repeat(13) + 'a'],
  ])('refuses a malformed stored sha (%s)', async (_label, sha) => {
    await expectRejectCode(
      callRetrigger({ forgejoCommitSha: sha, ...noBlockSha }),
      'INVALID_STORED_SHA'
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('IGNORES any caller-supplied sha — only the DB value reaches triggerBuild', async () => {
    // The tRPC input schema has no sha field, but pin the SERVICE too: even when a
    // caller smuggles extra properties into the params object, the sha handed to
    // triggerBuild is the one read from the row.
    mockDbWriteFindUnique.mockResolvedValue(strandedRow());
    const { retriggerBuild } = await import('../publish-request.service');
    await retriggerBuild({
      publishRequestId: REQ_ID,
      reviewerUserId: MOD_ID,
      // deliberately not part of RetriggerBuildParams
      ...({ sha: OTHER_SHA, forgejoCommitSha: OTHER_SHA } as unknown as object),
    } as never);
    expect(mockTriggerBuild).toHaveBeenCalledWith(expect.objectContaining({ sha: SHA }));
    expect(mockTriggerBuild).not.toHaveBeenCalledWith(expect.objectContaining({ sha: OTHER_SHA }));
  });
});

describe('retriggerBuild — guard 4: appBlockId must be present', () => {
  it('refuses a request with no backing app block', async () => {
    await expectRejectCode(
      callRetrigger({ appBlockId: null, appBlock: null }),
      'NOT_RETRIGGERABLE'
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });
});

describe('retriggerBuild — guard 5: superseded by a newer approved version', () => {
  it('refuses when the app has since moved to a DIFFERENT sha', async () => {
    await expectRejectCode(
      callRetrigger({ appBlock: { id: APB, currentVersionSha: OTHER_SHA } }),
      'NOT_RETRIGGERABLE'
    );
    // Rebuilding here would deploy OLDER code over the current version.
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('allows when the app current sha still matches this request', async () => {
    await expect(
      callRetrigger({ appBlock: { id: APB, currentVersionSha: SHA } })
    ).resolves.toBeTruthy();
  });

  it('allows when the app has no current sha yet (first version never deployed)', async () => {
    await expect(
      callRetrigger({ appBlock: { id: APB, currentVersionSha: null } })
    ).resolves.toBeTruthy();
  });
});

/**
 * TOCTOU — every guard value must come from the PRIMARY.
 *
 * `dbRead` is a SEPARATE readonly client that can lag behind `dbWrite`. Reading a
 * guard off it means deciding on a stale world: within the lag window an approval
 * that has already moved on still looks re-triggerable. Both races below are
 * expressed the only way that actually proves the fix — the replica is stubbed
 * with the PERMISSIVE (stale) row and the primary with the CURRENT one, so a
 * regression to `dbRead` flips each assertion.
 */
describe('retriggerBuild — reads its guards from the PRIMARY, not the replica', () => {
  it('never consults the read replica at all', async () => {
    await callRetrigger();
    expect(mockDbWriteFindUnique).toHaveBeenCalledTimes(1);
    expect(mockDbRead.appBlockPublishRequest.findUnique).not.toHaveBeenCalled();
  });

  it('RACE 1 — a v2 approval that has not reached the replica still supersedes v1', async () => {
    // Primary: the app has already moved to v2's sha (a mod approved it moments ago).
    mockDbWriteFindUnique.mockResolvedValue(
      strandedRow({
        deployState: 'failed',
        deployUpdatedAt: new Date(),
        appBlock: { id: APB, currentVersionSha: OTHER_SHA },
      })
    );
    // Replica: still serving the pre-approval world, where v1 IS the current sha.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      strandedRow({ deployState: 'failed', deployUpdatedAt: new Date() })
    );
    const { retriggerBuild } = await import('../publish-request.service');
    await expectRejectCode(
      retriggerBuild({ publishRequestId: REQ_ID, reviewerUserId: MOD_ID }),
      'NOT_RETRIGGERABLE'
    );
    // The whole point: v1's OLDER reviewed sha must not be rebuilt over v2.
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it("RACE 2 — a fresh approval's 'building' write is seen even if the replica lags", async () => {
    // Primary: approveRequest has already written 'building'.
    mockDbWriteFindUnique.mockResolvedValue(
      strandedRow({ deployState: 'building', deployUpdatedAt: new Date() })
    );
    // Replica: still null — the shape that used to look re-triggerable.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(strandedRow());
    const { retriggerBuild } = await import('../publish-request.service');
    await expectRejectCode(
      retriggerBuild({ publishRequestId: REQ_ID, reviewerUserId: MOD_ID }),
      'NOT_RETRIGGERABLE'
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled(); // no second PipelineRun
  });
});

/**
 * The remaining half of RACE 2, which no amount of primary-reading can fix:
 * `approveRequest` writes the approval, then AWAITS `triggerBuild` (a 30s network
 * timeout), and only THEN writes `deploy_state='building'`. During that WALL-CLOCK
 * window the primary itself legitimately reads null while a PipelineRun is already
 * being created. The null branch is therefore bounded by the shared
 * DEPLOY_PENDING_GRACE_MS.
 */
describe('retriggerBuild — guard 6b: the null deploy state is time-bounded', () => {
  it('refuses a JUST-approved request — its first build may still be starting', async () => {
    await expectRejectCode(callRetrigger({ reviewedAt: new Date() }), 'NOT_RETRIGGERABLE');
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('is EXCLUSIVE at exactly the grace boundary, and allows one ms past it', async () => {
    // The service reads its own Date.now(), so pin the clock to make the boundary
    // exact rather than "whatever elapsed between the two calls".
    vi.useFakeTimers();
    try {
      const now = new Date('2026-07-01T00:00:00Z').getTime();
      vi.setSystemTime(now);

      await expectRejectCode(
        callRetrigger({ reviewedAt: new Date(now - DEPLOY_PENDING_GRACE_MS) }),
        'NOT_RETRIGGERABLE'
      );
      expect(mockTriggerBuild).not.toHaveBeenCalled();

      await expect(
        callRetrigger({ reviewedAt: new Date(now - DEPLOY_PENDING_GRACE_MS - 1) })
      ).resolves.toBeTruthy();
      expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FAILS CLOSED when there is no anchor to measure the window from', async () => {
    await expectRejectCode(
      callRetrigger({ reviewedAt: null, deployUpdatedAt: null }),
      'NOT_RETRIGGERABLE'
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('falls back to deployUpdatedAt when reviewedAt is missing', async () => {
    await expect(
      callRetrigger({ reviewedAt: null, deployUpdatedAt: strandedReviewedAt() })
    ).resolves.toBeTruthy();
  });
});

describe('retriggerBuild — guard 6: deploy-state gate', () => {
  const stale = () => new Date(Date.now() - DEPLOY_STALE_AFTER_MS - 60_000);
  const freshTs = () => new Date(Date.now() - 30_000);

  it('refuses an ALREADY-DEPLOYED (live) version', async () => {
    await expectRejectCode(
      callRetrigger({ deployState: 'live', deployUpdatedAt: freshTs() }),
      'NOT_RETRIGGERABLE'
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it.each(['preview-building', 'preview-deploying', 'preview-live', 'preview-failed'])(
    'refuses the review-preview lane state %s',
    async (deployState) => {
      await expectRejectCode(
        callRetrigger({ deployState, deployUpdatedAt: stale() }),
        'NOT_RETRIGGERABLE'
      );
      expect(mockTriggerBuild).not.toHaveBeenCalled();
    }
  );

  it.each(['building', 'deploying'])(
    'refuses a FRESH in-flight %s (never race two PipelineRuns)',
    async (deployState) => {
      await expectRejectCode(
        callRetrigger({ deployState, deployUpdatedAt: freshTs() }),
        'NOT_RETRIGGERABLE'
      );
      expect(mockTriggerBuild).not.toHaveBeenCalled();
    }
  );

  it.each(['building', 'deploying'])(
    'ALLOWS a %s that has stalled past the shared threshold',
    async (deployState) => {
      await expect(callRetrigger({ deployState, deployUpdatedAt: stale() })).resolves.toBeTruthy();
      expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
    }
  );

  it('refuses an in-flight state with no timestamp to judge staleness by', async () => {
    await expectRejectCode(
      callRetrigger({ deployState: 'building', deployUpdatedAt: null }),
      'NOT_RETRIGGERABLE'
    );
  });

  it('refuses an unrecognized deploy state rather than guessing', async () => {
    await expectRejectCode(
      callRetrigger({ deployState: 'quantum', deployUpdatedAt: stale() }),
      'NOT_RETRIGGERABLE'
    );
  });
});

describe('retriggerBuild — guard 7: rate limit + double-click idempotency', () => {
  it('refuses when the per-moderator quota is exhausted', async () => {
    mockRedis.quotaAllowed = false;
    await expectRejectCode(callRetrigger(), 'RATE_LIMITED');
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('charges the quota to the SESSION moderator id', async () => {
    await callRetrigger();
    expect(limiter.quota).toHaveBeenCalledWith(MOD_ID);
  });

  it('a DOUBLE-FIRE within the lock window does not create a second build', async () => {
    // First call takes the lock.
    await callRetrigger();
    expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
    // Second call: the NX lock is already held.
    mockRedis.nxResult = false;
    await expectRejectCode(callRetrigger(), 'RATE_LIMITED');
    expect(mockTriggerBuild).toHaveBeenCalledTimes(1); // still ONE
  });

  it('takes the single-flight lock keyed on the publish request', async () => {
    await callRetrigger();
    expect(limiter.acquire).toHaveBeenCalledWith(REQ_ID);
  });

  it('checks the quota and the lock BEFORE triggering anything', async () => {
    mockRedis.quotaAllowed = false;
    await expectRejectCode(callRetrigger(), 'RATE_LIMITED');
    expect(limiter.acquire).not.toHaveBeenCalled();
    expect(mockSetCommitStatus).not.toHaveBeenCalled();
  });
});

describe('retriggerBuild — guard 8: a failing trigger becomes VISIBLE', () => {
  it("marks the request 'failed' with a reason when triggerBuild throws", async () => {
    mockTriggerBuild.mockRejectedValue(new Error('trigger 502 Bad Gateway'));
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');
    // This is the crux: the stranded-invisible state becomes a VISIBLE failure
    // even when the recovery itself fails.
    expect(deployWrites()).toEqual([
      {
        slug: 'my-app',
        sha: SHA,
        state: 'failed',
        detail: expect.stringContaining('Build re-trigger failed'),
      },
    ]);
  });

  it('flips the commit status to failure when triggerBuild throws', async () => {
    mockTriggerBuild.mockRejectedValue(new Error('boom'));
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failure', context: 'civitai/build' })
    );
  });

  it('frees the single-flight lock on failure so a retry is not wedged', async () => {
    mockTriggerBuild.mockRejectedValue(new Error('boom'));
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');
    expect(limiter.release).toHaveBeenCalledWith(REQ_ID);
  });

  it('never marks building when the trigger failed', async () => {
    mockTriggerBuild.mockRejectedValue(new Error('boom'));
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');
    expect(deployWrites().map((w) => w.state)).not.toContain('building');
  });
});

/**
 * 🔴 …AND VISIBLE IS NOT THE SAME AS VERBATIM.
 *
 * `deploy_detail` is OWNER-visible: both `blocks.listMyPublishRequests` and
 * `GET /api/v1/blocks/submissions` hand it to the app's THIRD-PARTY author. The
 * errors `triggerBuild` throws are internal — `trigger <status> <statusText>:
 * <first 240 bytes of the trigger receiver's response body>`, or a message naming
 * the trigger env vars. Storing them verbatim published our build infrastructure
 * to an app developer.
 *
 * These are the exact two thrown shapes, asserted against the STORED value.
 */
describe('retriggerBuild — the trigger failure must not leak internals to the author', () => {
  // A SYNTHETIC stand-in for whatever the trigger receiver returns on a bad day:
  // a stack trace plus deployment-internal identifiers. The point of the assertions
  // is that NONE of it survives into the author-visible column, so the exact bytes
  // are irrelevant — only that they are distinctive enough to detect.
  const RECEIVER_BODY =
    'SENTINEL-TRACE-A1: SENTINEL-INTERNAL-B2 rejected the request ' +
    '(SENTINEL-IDENTIFIER-C3 / SENTINEL-CREDENTIAL-D4 expired)';

  it('stores NO part of the trigger receiver response body', async () => {
    mockTriggerBuild.mockRejectedValue(
      new Error(`trigger 500 Internal Server Error: ${RECEIVER_BODY}`)
    );
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');

    const detail = deployWrites()[0].detail ?? '';
    expect(detail).not.toContain(RECEIVER_BODY);
    // Per-token, so a partially-copied body is caught too — not just the whole string.
    for (const fragment of [
      'SENTINEL-TRACE-A1',
      'SENTINEL-INTERNAL-B2',
      'SENTINEL-IDENTIFIER-C3',
      'SENTINEL-CREDENTIAL-D4',
      'Internal Server Error',
      'trigger 500',
    ]) {
      expect(detail).not.toContain(fragment);
    }
  });

  it('stores NO env-var name when the trigger is unconfigured', async () => {
    mockTriggerBuild.mockRejectedValue(
      new Error('APPS_TEKTON_TRIGGER_URL / APPS_TEKTON_TRIGGER_SECRET not configured')
    );
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');

    const detail = deployWrites()[0].detail ?? '';
    expect(detail).not.toContain('APPS_TEKTON_TRIGGER_URL');
    expect(detail).not.toContain('APPS_TEKTON_TRIGGER_SECRET');
    expect(detail).not.toContain('TEKTON');
  });

  it('stores the FIXED author-facing message — identical whatever was thrown', async () => {
    const { RETRIGGER_FAILED_AUTHOR_DETAIL } = await import('../publish-request.service');

    mockTriggerBuild.mockRejectedValue(new Error(`trigger 502 Bad Gateway: ${RECEIVER_BODY}`));
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');
    const first = deployWrites()[0].detail;

    vi.clearAllMocks();
    mockTriggerBuild.mockRejectedValue(new Error('SENTINEL-CONNECT-E5 refused'));
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');
    const second = deployWrites()[0].detail;

    expect(first).toBe(RETRIGGER_FAILED_AUTHOR_DETAIL);
    expect(second).toBe(RETRIGGER_FAILED_AUTHOR_DETAIL);
  });

  it('the stored detail survives sanitizeBuildFailureReason unchanged (the invariant)', async () => {
    const { RETRIGGER_FAILED_AUTHOR_DETAIL } = await import('../publish-request.service');
    const { sanitizeBuildFailureReason } = await import('../build-failure-reason');
    // The value is written THROUGH the sanitizer, so the stored bytes are
    // guaranteed printable + bounded like every other deploy_detail write.
    expect(sanitizeBuildFailureReason(RETRIGGER_FAILED_AUTHOR_DETAIL)).toBe(
      RETRIGGER_FAILED_AUTHOR_DETAIL
    );
  });

  it('does not leak the receiver body through the Forgejo commit status either', async () => {
    mockTriggerBuild.mockRejectedValue(
      new Error(`trigger 500 Internal Server Error: ${RECEIVER_BODY}`)
    );
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');
    const failure = mockSetCommitStatus.mock.calls
      .map((c) => c[0] as { state: string; description: string })
      .find((c) => c.state === 'failure');
    expect(failure?.description ?? '').not.toContain('SENTINEL-TRACE-A1');
    expect(failure?.description ?? '').not.toContain('SENTINEL-INTERNAL-B2');
  });

  it('logs the INTERNAL detail server-side so the failure is still diagnosable', async () => {
    const { logToAxiom } = await import('~/server/logging/client');
    mockTriggerBuild.mockRejectedValue(
      new Error(`trigger 500 Internal Server Error: ${RECEIVER_BODY}`)
    );
    await expectRejectCode(callRetrigger(), 'TRIGGER_FAILED');
    // The dynamic import + `.then` chain resolves on a later microtask tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-block-retrigger-failed',
        details: expect.objectContaining({
          publishRequestId: REQ_ID,
          error: expect.stringContaining(RECEIVER_BODY),
        }),
      }),
      'app-blocks'
    );
  });
});
