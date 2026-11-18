import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TRPCError } from '@trpc/server';
import { NsfwLevel } from '~/server/common/enums';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import {
  OUTPUT_UNLOCK_IN_PROGRESS_MESSAGE,
  OUTPUT_UNLOCK_LINK_OUT_MESSAGE,
  OUTPUT_UNLOCK_LOCK_TTL_SECONDS,
  OUTPUT_UNLOCK_ORCHESTRATOR_TIMEOUT_MS,
  OUTPUT_UNLOCK_PRICE_CHANGED_MESSAGE,
  OUTPUT_UNLOCK_SETTINGS_MESSAGE,
  planBlockOutputUnlock,
  previewBlockOutputUnlock,
  unlockBlockOutput,
  unlockPriceFromTransactions,
  type OutputUnlockClaims,
  type OutputUnlockDeps,
} from '~/server/services/blocks/block-output-unlock.service';
import { BLOCK_STEP_NAME, appBlockTag } from '~/server/services/blocks/workflow.service';
import type * as WorkflowServiceModule from '~/server/services/blocks/workflow.service';

/** Makes the level read behind the charged-not-released WARN throw; the snapshot path is untouched. */
const projection = vi.hoisted(() => ({ throws: false }));
vi.mock('~/server/services/blocks/workflow.service', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowServiceModule>();
  return {
    ...actual,
    projectAppWorkflowWithPositions: (
      ...args: Parameters<typeof actual.projectAppWorkflowWithPositions>
    ) => {
      if (projection.throws) throw new Error('projection failed');
      return actual.projectAppWorkflowWithPositions(...args);
    },
  };
});
import { ORCHESTRATOR_GET_TIMEOUT_MS } from '~/server/services/orchestrator/workflows';

/**
 * The App Block OUTPUT UNLOCK (task e982 part C): the host's dialog unlocks one restricted output
 * in place. Every guard below is driven through the service with the outside world faked, so each
 * test names the dependency it expects called or NOT called.
 *
 * The unlock price (137) is derived from the fixture's transactions (157 debited, 20 credited, a
 * yellow debit ignored), so a mutant that read any one of them alone would move it.
 *
 * NO AUTHOR SHARE (operator decision): the deps have no fee capability at all, so the
 * fee-accrued case is pinned where the real charge lives, the router seam test
 * `blocks.router.outputUnlock.test.ts`.
 */

const VIEWER = 42;
const OTHER_VIEWER = 7;
const APP = 'app_live_characters';
const WF = `${VIEWER}-20261115120000000`;
const ALL = 1 | 2 | 4 | 8 | 16;
const SFW = 1 | 2;
const UPTO_R = 1 | 2 | 4;

/** A red (mature) app token for a viewer with mature content on. */
const RED_MATURE: OutputUnlockClaims = {
  sub: `user:${VIEWER}`,
  appId: APP,
  maxBrowsingLevel: ALL,
  viewerBrowsingLevel: ALL,
};
/** An SFW-domain app token: the DOMAIN keeps mature out. */
const SFW_DOMAIN: OutputUnlockClaims = { ...RED_MATURE, maxBrowsingLevel: SFW };
/** Red, but the viewer's own browsing level stops at PG-13. */
const RED_VIEWER_SFW: OutputUnlockClaims = { ...RED_MATURE, viewerBrowsingLevel: SFW };

const UNLOCK_PRICE = 137;
const TOTAL = UNLOCK_PRICE;

function image(id: string, nsfwLevel: string | null) {
  return {
    id,
    type: 'image',
    url: `https://cdn/${id}.png`,
    available: true,
    width: 512,
    height: 768,
    ...(nsfwLevel === null ? {} : { nsfwLevel }),
  };
}

/** A succeeded block workflow whose Blue spend refused mature content (the 'pool' case). */
function workflow(
  images: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {}
): Awaited<ReturnType<OutputUnlockDeps['readWorkflow']>> {
  return {
    id: WF,
    createdAt: '2026-11-15T12:00:00.000Z',
    status: 'succeeded',
    metadata: {},
    tags: [appBlockTag(APP)],
    allowMatureContent: false,
    cost: { total: UNLOCK_PRICE },
    transactions: {
      list: [
        { type: 'debit', amount: UNLOCK_PRICE + 20, accountType: 'blue' },
        { type: 'credit', amount: 20, accountType: 'blue' },
      ],
    },
    steps: [
      { $type: 'textToImage', name: 's1', status: 'succeeded', metadata: {}, output: { images } },
    ],
    ...over,
  } as never;
}

const LOCKED = () => workflow([image('pg0', 'pg'), image('r1', 'r')]);
const UNLOCKED = () =>
  workflow([image('pg0', 'pg'), image('r1', 'r')], { allowMatureContent: true });

type D = OutputUnlockDeps;
type Wf = Awaited<ReturnType<D['readWorkflow']>>;
type Fakes = { [K in keyof D]: Mock<D[K]> } & { release: Mock<() => Promise<void>> };

function fakes(reads: Array<() => Wf>, over: Partial<Fakes> = {}): Fakes {
  const queue = [...reads];
  const release = vi.fn<() => Promise<void>>(async () => undefined);
  return {
    readWorkflow: vi.fn<D['readWorkflow']>(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return next();
    }),
    assertUnlockAllowed: vi.fn<D['assertUnlockAllowed']>(() => undefined),
    assertUnlockReleasesOutput: vi.fn<D['assertUnlockReleasesOutput']>(async () => undefined),
    liftRestriction: vi.fn<D['liftRestriction']>(async () => ({ outcome: 'lifted' })),
    acquireLock: vi.fn<D['acquireLock']>(async () => release),
    warnChargedNotReleased: vi.fn<D['warnChargedNotReleased']>(() => undefined),
    release,
    ...over,
  };
}

const NO_VIEW = { serving: false, mint: null };

const request = (claims: OutputUnlockClaims = RED_MATURE, position = 1) => ({
  workflowId: WF,
  position,
  viewerUserId: VIEWER,
  view: { serving: false, mint: null },
  claims,
});

async function rejection(p: Promise<unknown>): Promise<TRPCError> {
  const error = await p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

/** Nothing reached the orchestrator write: the only place an unlock moves Buzz. */
function expectNothingSpent(f: Fakes) {
  expect(f.liftRestriction).not.toHaveBeenCalled();
}

beforeEach(() => {
  // `assertBlockWorkflowMintedForViewer` is a no-op in dev mode, which would make the ownership
  // tests vacuous.
  resetEnv();
  setEnv({ ORCHESTRATOR_MODE: 'prod' });
});
afterEach(() => resetEnv());

describe('unlock price', () => {
  it('is the net non-yellow spend, as the site computes it', () => {
    expect(
      unlockPriceFromTransactions([
        { type: 'debit', amount: 157, accountType: 'blue' },
        { type: 'credit', amount: 20, accountType: 'blue' },
        { type: 'debit', amount: 999, accountType: 'yellow' },
      ])
    ).toBe(UNLOCK_PRICE);
  });
});

describe('ownership', () => {
  it('refuses a workflow minted for another viewer before reading or spending anything', async () => {
    const f = fakes([LOCKED]);
    const error = await rejection(
      unlockBlockOutput(
        { ...request(), workflowId: `${OTHER_VIEWER}-20261115120000000`, expectedTotal: TOTAL },
        f
      )
    );
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('workflow does not belong to this viewer');
    expect(f.readWorkflow).not.toHaveBeenCalled();
    expect(f.acquireLock).not.toHaveBeenCalled();
    expectNothingSpent(f);
  });

  it('refuses a preview of a workflow minted for another viewer', async () => {
    const f = fakes([LOCKED]);
    const error = await rejection(
      previewBlockOutputUnlock({ ...request(), workflowId: `${OTHER_VIEWER}-1` }, f)
    );
    expect(error.message).toBe('workflow does not belong to this viewer');
    expect(f.readWorkflow).not.toHaveBeenCalled();
  });

  it("refuses the viewer's own workflow when it was generated by another app", async () => {
    const f = fakes([() => workflow([image('r1', 'r')], { tags: [appBlockTag('app_other')] })]);
    const error = await rejection(
      unlockBlockOutput({ ...request(RED_MATURE, 0), expectedTotal: TOTAL }, f)
    );
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('workflow is not tagged for this app');
    expectNothingSpent(f);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});

describe("the 'pool' restriction: pay and unlock in place", () => {
  it("previews the price: the orchestrator's yellow unlock, nothing added", async () => {
    const f = fakes([LOCKED]);
    expect(await previewBlockOutputUnlock(request(), f)).toStrictEqual({
      kind: 'pay',
      position: 1,
      unlockBuzz: UNLOCK_PRICE,
    });
    expectNothingSpent(f);
  });

  it('unlocks: lifts the restriction and returns the url', async () => {
    const f = fakes([LOCKED, LOCKED, UNLOCKED]);
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('unlocked');
    expect(result.snapshot.outputs?.[1]).toStrictEqual({
      url: 'https://cdn/r1.png',
      nsfwLevel: 'r',
    });
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(f.liftRestriction).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("the orchestrator's insufficient-Yellow refusal is 'refused', with a message", async () => {
    const f = fakes([LOCKED], {
      liftRestriction: vi.fn<D['liftRestriction']>(async () => ({ outcome: 'insufficient-funds' })),
    });
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(result).toStrictEqual({
      outcome: 'refused',
      snapshot: expect.anything(),
      charged: { unlockBuzz: 0 },
      message: 'You do not have enough yellow Buzz to unlock this output.',
    });
    expect(result.snapshot.outputs?.[1]).toStrictEqual({ restricted: true, reason: 'pool' });
    // The plan read and the pre-lift re-plan; no read-back after a refused lift.
    expect(f.readWorkflow).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('an output opened between the plan and the charge is not charged for', async () => {
    const f = fakes([LOCKED, UNLOCKED]);
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('not-restricted');
    expect(result.charged).toStrictEqual({ unlockBuzz: 0 });
    expect(f.liftRestriction).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('refuses a total above the one the viewer confirmed, before the orchestrator write', async () => {
    const f = fakes([LOCKED]);
    const error = await rejection(unlockBlockOutput({ ...request(), expectedTotal: TOTAL - 1 }, f));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe(OUTPUT_UNLOCK_PRICE_CHANGED_MESSAGE);
    expectNothingSpent(f);
  });

  it("runs the site's own unlock guards before spending", async () => {
    const f = fakes([LOCKED], {
      assertUnlockAllowed: vi.fn<D['assertUnlockAllowed']>(() => {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'mature content off' });
      }),
    });
    const error = await rejection(unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f));
    expect(error.message).toBe('mature content off');
    expectNothingSpent(f);
  });
});

describe('idempotency', () => {
  it('a retry after a successful unlock returns the url and charges nothing', async () => {
    const f = fakes([UNLOCKED]);
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('not-restricted');
    expect(result.snapshot.outputs?.[1]).toStrictEqual({
      url: 'https://cdn/r1.png',
      nsfwLevel: 'r',
    });
    expect(result.charged).toStrictEqual({ unlockBuzz: 0 });
    expectNothingSpent(f);
    expect(f.assertUnlockReleasesOutput).not.toHaveBeenCalled();
  });

  it('a concurrent second unlock of the same workflow is refused while the first holds the lock', async () => {
    const f = fakes([LOCKED], { acquireLock: vi.fn<D['acquireLock']>(async () => null) });
    const error = await rejection(unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe(OUTPUT_UNLOCK_IN_PROGRESS_MESSAGE);
    expect(f.readWorkflow).not.toHaveBeenCalled();
    expectNothingSpent(f);
  });

  it('the lock outlives every bounded call made under it', () => {
    // The plan read, the release check and the re-classify (three reads, bounded by the real
    // `ORCHESTRATOR_GET_TIMEOUT_MS`, so a change there is seen here), plus the write.
    expect(ORCHESTRATOR_GET_TIMEOUT_MS).toBeGreaterThan(0);
    expect(OUTPUT_UNLOCK_LOCK_TTL_SECONDS * 1000).toBeGreaterThan(
      OUTPUT_UNLOCK_ORCHESTRATOR_TIMEOUT_MS + 3 * ORCHESTRATOR_GET_TIMEOUT_MS
    );
  });
});

describe('failure paths: the lock is released, nothing else is touched', () => {
  it('the orchestrator failing the write', async () => {
    const f = fakes([LOCKED], {
      liftRestriction: vi.fn<D['liftRestriction']>(async () => {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'orchestrator unavailable' });
      }),
    });
    const error = await rejection(unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f));
    expect(error.message).toBe('orchestrator unavailable');
    // A failed unlock releases its lock.
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('the re-read before the charge failing: an error, nothing charged', async () => {
    let reads = 0;
    const f = fakes([LOCKED], {
      readWorkflow: vi.fn<D['readWorkflow']>(async () => {
        reads += 1;
        if (reads === 1) return LOCKED();
        throw new Error('orchestrator read timed out');
      }),
    });
    await expect(unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f)).rejects.toThrow(
      'orchestrator read timed out'
    );
    expect(f.liftRestriction).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('the read-back after the charge failing still reports the charge and warns', async () => {
    let reads = 0;
    const f = fakes([LOCKED], {
      readWorkflow: vi.fn<D['readWorkflow']>(async () => {
        reads += 1;
        if (reads <= 2) return LOCKED();
        throw new Error('orchestrator read timed out');
      }),
    });
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(f.liftRestriction).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('not-released');
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(result.message).toBe(
      "The unlock went through, but we couldn't load the output. Check again in a few minutes."
    );
    // The pre-lift snapshot: the output stays restricted, no url leaks.
    expect(result.snapshot.outputs?.[1]).toMatchObject({ restricted: true });
    expect(JSON.stringify(result)).not.toContain('r1.png');
    expect(f.warnChargedNotReleased).toHaveBeenCalledWith({
      userId: VIEWER,
      workflowId: WF,
      position: 1,
      unlockBuzz: UNLOCK_PRICE,
      plannedLevel: NsfwLevel.R,
      servedLevel: null,
      readBackFailed: true,
    });
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('🔴 the unlock succeeding at the orchestrator but the output landing above the viewer ceiling', async () => {
    // The viewer allows up to R. Before the unlock the output was R ('pool'); the orchestrator's
    // read-back rates it X. The re-classification at the token ceiling must keep it restricted.
    const claims: OutputUnlockClaims = { ...RED_MATURE, viewerBrowsingLevel: UPTO_R };
    const f = fakes([
      LOCKED,
      LOCKED,
      () => workflow([image('pg0', 'pg'), image('r1', 'x')], { allowMatureContent: true }),
    ]);
    const result = await unlockBlockOutput({ ...request(claims), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('not-released');
    // The viewer is told why the output is still withheld.
    expect(result.message).toBe(
      'The unlock went through, but this output is rated above your browsing level, so it stays hidden.'
    );
    expect(result.snapshot.outputs?.[1]).toStrictEqual({ restricted: true, reason: 'ceiling' });
    expect(JSON.stringify(result)).not.toContain('r1.png');
    // The lift was taken, so the reply reports the charge, and support gets a WARN to act on.
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(f.warnChargedNotReleased).toHaveBeenCalledWith({
      userId: VIEWER,
      workflowId: WF,
      position: 1,
      unlockBuzz: UNLOCK_PRICE,
      plannedLevel: NsfwLevel.R,
      servedLevel: NsfwLevel.X,
      readBackFailed: false,
    });
  });
});

describe("'ceiling' and 'unrated': never charged", () => {
  /** An imageResourceTraining sample: never rated, so 'unrated' wherever a rating could restrict. */
  const unratedSample = () =>
    workflow([], {
      allowMatureContent: undefined,
      steps: [
        {
          $type: 'imageResourceTraining',
          name: BLOCK_STEP_NAME,
          status: 'succeeded',
          output: {
            moderationStatus: 'approved',
            epochs: [{ epochNumber: 1, sampleImages: ['https://cdn/sample.png'] }],
          },
        },
      ],
    });
  /** An R output on an SFW app: the site sent `allowMatureContent: false` itself. */
  const sfwSiteRefused = () => workflow([image('r1', 'r')]);

  it('the SFW DOMAIN keeping a rated output out: link out to civitai.red, no charge', async () => {
    expect(planBlockOutputUnlock(sfwSiteRefused(), SFW_DOMAIN, 0, NO_VIEW)).toStrictEqual({
      kind: 'link-out',
      position: 0,
      message: OUTPUT_UNLOCK_LINK_OUT_MESSAGE,
    });
    const f = fakes([sfwSiteRefused]);
    const error = await rejection(
      unlockBlockOutput({ ...request(SFW_DOMAIN, 0), expectedTotal: TOTAL }, f)
    );
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(OUTPUT_UNLOCK_LINK_OUT_MESSAGE);
    expectNothingSpent(f);
  });

  it("'unrated' on an SFW domain is treated exactly like 'ceiling': link out, no charge", async () => {
    const plan = planBlockOutputUnlock(unratedSample(), SFW_DOMAIN, 0, NO_VIEW);
    expect(plan).toStrictEqual({
      kind: 'link-out',
      position: 0,
      message: OUTPUT_UNLOCK_LINK_OUT_MESSAGE,
    });
    const f = fakes([unratedSample]);
    await rejection(unlockBlockOutput({ ...request(SFW_DOMAIN, 0), expectedTotal: TOTAL }, f));
    expectNothingSpent(f);
  });

  it("the viewer's own level cutting it on red: unavailable, pointing at their settings, not at red", async () => {
    const lockedOnRed = () => workflow([image('r1', 'r')], { allowMatureContent: true });
    expect(planBlockOutputUnlock(lockedOnRed(), RED_VIEWER_SFW, 0, NO_VIEW)).toStrictEqual({
      kind: 'unavailable',
      position: 0,
      message: OUTPUT_UNLOCK_SETTINGS_MESSAGE,
    });
    const f = fakes([lockedOnRed]);
    const error = await rejection(
      unlockBlockOutput({ ...request(RED_VIEWER_SFW, 0), expectedTotal: TOTAL }, f)
    );
    expect(error.message).toBe(OUTPUT_UNLOCK_SETTINGS_MESSAGE);
    expectNothingSpent(f);
  });

  it("'unrated' with the viewer's own level cutting it on red: the same settings pointer", () => {
    expect(planBlockOutputUnlock(unratedSample(), RED_VIEWER_SFW, 0, NO_VIEW)).toStrictEqual({
      kind: 'unavailable',
      position: 0,
      message: OUTPUT_UNLOCK_SETTINGS_MESSAGE,
    });
  });

  it('a preview of a ceiling output carries no price', async () => {
    const f = fakes([sfwSiteRefused]);
    const preview = await previewBlockOutputUnlock(request(SFW_DOMAIN, 0), f);
    expect(preview.kind).toBe('link-out');
    expect(preview).not.toHaveProperty('unlockBuzz');
  });
});

describe('the orchestrator write got no response (our timeout)', () => {
  it('🔴 returns the non-retryable outcome and KEEPS the lock until its TTL', async () => {
    const f = fakes([LOCKED], {
      liftRestriction: vi.fn<D['liftRestriction']>(async () => ({ outcome: 'no-response' })),
    });
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('unavailable');
    expect(result.message).toBe(
      'Your unlock may still be going through. Check again in a few minutes.'
    );
    expect(result.charged).toStrictEqual({ unlockBuzz: 0 });
    expect(JSON.stringify(result)).not.toContain('r1.png');
    // The write may still land: the lock is not released, so a retry is refused as in progress.
    expect(f.release).not.toHaveBeenCalled();
  });
});

describe('🔴 no price, no offer', () => {
  it('missing transactions: unavailable, never pay, and the unlock asks the orchestrator nothing', async () => {
    const noTransactions = () =>
      workflow([image('pg0', 'pg'), image('r1', 'r')], { transactions: undefined });
    expect(planBlockOutputUnlock(noTransactions(), RED_MATURE, 1, NO_VIEW)).toStrictEqual({
      kind: 'unavailable',
      position: 1,
      message: "We couldn't work out the price for this unlock. Try again shortly.",
    });
    const f = fakes([noTransactions]);
    const error = await rejection(unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f));
    expect(error.message).toBe(
      "We couldn't work out the price for this unlock. Try again shortly."
    );
    expectNothingSpent(f);
  });

  it('an empty transaction list: unavailable', () => {
    const empty = workflow([image('pg0', 'pg'), image('r1', 'r')], { transactions: { list: [] } });
    expect(planBlockOutputUnlock(empty, RED_MATURE, 1, NO_VIEW)).toStrictEqual({
      kind: 'unavailable',
      position: 1,
      message: "We couldn't work out the price for this unlock. Try again shortly.",
    });
  });

  it('only yellow spent (nothing to swap): unavailable', () => {
    const yellowOnly = workflow([image('pg0', 'pg'), image('r1', 'r')], {
      transactions: { list: [{ type: 'debit', amount: 157, accountType: 'yellow' }] },
    });
    expect(planBlockOutputUnlock(yellowOnly, RED_MATURE, 1, NO_VIEW)).toMatchObject({
      kind: 'unavailable',
    });
  });
});

describe('plan edges', () => {
  it('an output that already has a url is not-restricted, and the preview carries no url', async () => {
    const f = fakes([LOCKED]);
    const preview = await previewBlockOutputUnlock(request(RED_MATURE, 0), f);
    expect(preview).toStrictEqual({ kind: 'not-restricted', position: 0 });
    expect(JSON.stringify(preview)).not.toContain('pg0.png');
  });

  it('a position past the end is refused', async () => {
    const f = fakes([LOCKED]);
    const error = await rejection(previewBlockOutputUnlock(request(RED_MATURE, 5), f));
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('output 5 does not exist');
  });
});

describe('🔴 serving on: the unlock decides on the released output, not on its ticket', () => {
  const SERVING = { serving: true, mint: { userId: VIEWER, appBlockId: 'apb_1' } };
  const servingRequest = () => ({ ...request(), view: SERVING, expectedTotal: TOTAL });
  const blob = (id: string, nsfwLevel: string) => ({
    ...image(id, nsfwLevel),
    url: `https://orch.example/v2/consumer/blobs/${id}?sig=s`,
  });

  it('a released output that cannot be minted still reports the charge', async () => {
    // `https://cdn/...` has no consumer blob id, so no ticket can be issued for it.
    const f = fakes([LOCKED, LOCKED, UNLOCKED]);
    const result = await unlockBlockOutput(servingRequest(), f);
    expect(result.outcome).toBe('unlocked');
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(result.snapshot.outputs?.[1]).toStrictEqual({
      restricted: true,
      reason: 'unrecognised_url',
    });
    expect(f.liftRestriction).toHaveBeenCalledTimes(1);
  });

  it('a retry after that sees the output released: it mints again and charges nothing', async () => {
    const f = fakes([
      () => workflow([blob('pg0', 'pg'), blob('r1', 'r')], { allowMatureContent: true }),
    ]);
    const result = await unlockBlockOutput(servingRequest(), f);
    expect(result.outcome).toBe('not-restricted');
    expect(result.charged).toStrictEqual({ unlockBuzz: 0 });
    expect(f.liftRestriction).not.toHaveBeenCalled();
    const output = result.snapshot.outputs?.[1] as { url: string; mediaRef?: string };
    expect(output.url.startsWith('/api/v1/blocks/media/')).toBe(true);
    expect(typeof output.mediaRef).toBe('string');
  });

  /** A never-rated engine's video, rated R, on a workflow whose paying pool refused mature content. */
  const neverRatedR = () =>
    workflow([], {
      steps: [
        {
          $type: 'videoGen',
          name: BLOCK_STEP_NAME,
          status: 'succeeded',
          metadata: {},
          input: { engine: 'kling' },
          output: { video: { ...blob('v1', 'r'), type: 'video' } },
        },
      ],
    });

  it('an output the serving rules restrict once released is never offered for pay, and nothing is charged', async () => {
    expect(planBlockOutputUnlock(neverRatedR(), RED_MATURE, 0, SERVING)).toMatchObject({
      kind: 'unavailable',
      message: 'This output cannot be shown here.',
    });
    const f = fakes([neverRatedR]);
    await expect(
      unlockBlockOutput({ ...request(RED_MATURE, 0), view: SERVING, expectedTotal: TOTAL }, f)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.liftRestriction).not.toHaveBeenCalled();
  });

  it('CONTROL: with serving off the same output is released and charged as before', async () => {
    expect(planBlockOutputUnlock(neverRatedR(), RED_MATURE, 0, NO_VIEW)).toMatchObject({
      kind: 'pay',
    });
    const released = () => ({ ...neverRatedR(), allowMatureContent: true } as Wf);
    const f = fakes([neverRatedR, neverRatedR, released]);
    const result = await unlockBlockOutput({ ...request(RED_MATURE, 0), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('unlocked');
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(f.liftRestriction).toHaveBeenCalledTimes(1);
  });

  it('a lift the orchestrator did not release reports the charge, never 0', async () => {
    const f = fakes([LOCKED, LOCKED, LOCKED]);
    const result = await unlockBlockOutput(servingRequest(), f);
    expect(result.outcome).toBe('not-released');
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(f.warnChargedNotReleased).toHaveBeenCalledTimes(1);
  });

  it('a released output that mints is returned as a ticket with a mediaRef', async () => {
    const f = fakes([
      () => workflow([blob('pg0', 'pg'), blob('r1', 'r')]),
      () => workflow([blob('pg0', 'pg'), blob('r1', 'r')]),
      () => workflow([blob('pg0', 'pg'), blob('r1', 'r')], { allowMatureContent: true }),
    ]);
    const result = await unlockBlockOutput(servingRequest(), f);
    expect(result.outcome).toBe('unlocked');
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(f.liftRestriction).toHaveBeenCalledTimes(1);
    const output = result.snapshot.outputs?.[1] as { url: string; mediaRef?: string };
    expect(output.url.startsWith('/api/v1/blocks/media/')).toBe(true);
    expect(typeof output.mediaRef).toBe('string');
  });

  it('CONTROL: with serving off the same unlock returns the orchestrator url', async () => {
    const f = fakes([
      () => workflow([blob('pg0', 'pg'), blob('r1', 'r')]),
      () => workflow([blob('pg0', 'pg'), blob('r1', 'r')]),
      () => workflow([blob('pg0', 'pg'), blob('r1', 'r')], { allowMatureContent: true }),
    ]);
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect((result.snapshot.outputs?.[1] as { url: string }).url).toBe(
      'https://orch.example/v2/consumer/blobs/r1?sig=s'
    );
  });
});

describe('🔴 the plan/lift race: a rescan before the charge is never charged for', () => {
  const rescanned = (rating: string) => () => workflow([image('pg0', 'pg'), image('r1', rating)]);
  const unlock = (f: Fakes, claims: OutputUnlockClaims = RED_MATURE) =>
    unlockBlockOutput({ ...request(claims), expectedTotal: TOTAL }, f);

  it('R when planned, X above the ceiling by the pre-lift read: refused, nothing lifted', async () => {
    const claims: OutputUnlockClaims = { ...RED_MATURE, viewerBrowsingLevel: UPTO_R };
    const f = fakes([LOCKED, rescanned('x')]);
    await expect(unlock(f, claims)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.liftRestriction).not.toHaveBeenCalled();
    expect(f.warnChargedNotReleased).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('a price that moved by the pre-lift read is refused, nothing lifted', async () => {
    const repriced = () =>
      workflow([image('pg0', 'pg'), image('r1', 'r')], {
        transactions: { list: [{ type: 'debit', amount: UNLOCK_PRICE + 5, accountType: 'blue' }] },
      });
    const f = fakes([LOCKED, repriced]);
    await expect(unlock(f)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.liftRestriction).not.toHaveBeenCalled();
  });

  it('CONTROL: a stable R is lifted, released and charged, with no WARN', async () => {
    const f = fakes([LOCKED, LOCKED, UNLOCKED]);
    const result = await unlock(f);
    expect(result.outcome).toBe('unlocked');
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(f.warnChargedNotReleased).not.toHaveBeenCalled();
  });

  it('CONTROL: no response from the lift still reports nothing charged, with no WARN', async () => {
    const f = fakes([LOCKED], {
      liftRestriction: vi.fn<D['liftRestriction']>(async () => ({ outcome: 'no-response' })),
    });
    const result = await unlock(f);
    expect(result.charged).toStrictEqual({ unlockBuzz: 0 });
    expect(f.warnChargedNotReleased).not.toHaveBeenCalled();
  });
});

describe('🔴 no serve decision: nothing is offered or charged', () => {
  const UNKNOWN = { serving: false, servingUnknown: true as const, mint: null };

  it('a pool-locked output is not offered for pay', () => {
    expect(planBlockOutputUnlock(LOCKED(), RED_MATURE, 1, UNKNOWN)).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('CONTROL: the same output with serving off is offered for pay', () => {
    expect(planBlockOutputUnlock(LOCKED(), RED_MATURE, 1, NO_VIEW)).toMatchObject({ kind: 'pay' });
  });

  it('the confirmed unlock is refused before the lift, nothing charged', async () => {
    const f = fakes([LOCKED]);
    await expect(
      unlockBlockOutput({ ...request(), view: UNKNOWN, expectedTotal: TOTAL }, f)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.liftRestriction).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});

describe('🔴 a viewer judged as signed out: nothing is offered or charged', () => {
  const SIGNED_OUT = { serving: true, anonymous: true as const, mint: null };

  it('a pool-locked output is not offered for pay', () => {
    expect(planBlockOutputUnlock(LOCKED(), RED_MATURE, 1, SIGNED_OUT)).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('CONTROL: the same output for a signed-in viewer with serving on is offered for pay', () => {
    expect(
      planBlockOutputUnlock(LOCKED(), RED_MATURE, 1, { serving: true, mint: null })
    ).toMatchObject({ kind: 'pay' });
  });

  it('the confirmed unlock is refused before the lift, nothing charged', async () => {
    const f = fakes([LOCKED]);
    await expect(
      unlockBlockOutput({ ...request(), view: SIGNED_OUT, expectedTotal: TOTAL }, f)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.liftRestriction).not.toHaveBeenCalled();
  });
});

describe('the WARN level read failing', () => {
  afterEach(() => {
    projection.throws = false;
  });

  it('a level read that throws still reports the charge, and the WARN carries no levels', async () => {
    projection.throws = true;
    const f = fakes([LOCKED, LOCKED, LOCKED]);
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('not-released');
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(f.warnChargedNotReleased).toHaveBeenCalledWith(
      expect.objectContaining({ plannedLevel: null, servedLevel: null, readBackFailed: false })
    );
  });
});
