import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TRPCError } from '@trpc/server';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import {
  OUTPUT_UNLOCK_IN_PROGRESS_MESSAGE,
  OUTPUT_UNLOCK_LINK_OUT_MESSAGE,
  OUTPUT_UNLOCK_LOCK_TTL_SECONDS,
  OUTPUT_UNLOCK_ORCHESTRATOR_TIMEOUT_MS,
  OUTPUT_UNLOCK_PRICE_CHANGED_MESSAGE,
  OUTPUT_UNLOCK_READ_TIMEOUT_MS,
  OUTPUT_UNLOCK_SETTINGS_MESSAGE,
  planBlockOutputUnlock,
  previewBlockOutputUnlock,
  unlockBlockOutput,
  unlockPriceFromTransactions,
  type OutputUnlockClaims,
  type OutputUnlockDeps,
} from '~/server/services/blocks/block-output-unlock.service';
import { BLOCK_STEP_NAME, appBlockTag } from '~/server/services/blocks/workflow.service';

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
type Fakes = { [K in keyof D]: Mock<D[K]> } & {
  refund: Mock<(amount: number) => Promise<void>>;
  release: Mock<() => Promise<void>>;
};

function fakes(reads: Array<() => Wf>, over: Partial<Fakes> = {}): Fakes {
  const queue = [...reads];
  const refund = vi.fn<(amount: number) => Promise<void>>(async () => undefined);
  const release = vi.fn<() => Promise<void>>(async () => undefined);
  return {
    readWorkflow: vi.fn<D['readWorkflow']>(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return next();
    }),
    assertUnlockAllowed: vi.fn<D['assertUnlockAllowed']>(() => undefined),
    assertUnlockReleasesOutput: vi.fn<D['assertUnlockReleasesOutput']>(async () => undefined),
    reserveSpend: vi.fn<D['reserveSpend']>(async () => ({ refund })),
    liftRestriction: vi.fn<D['liftRestriction']>(async () => undefined),
    acquireLock: vi.fn<D['acquireLock']>(async () => release),
    refund,
    release,
    ...over,
  };
}

const request = (claims: OutputUnlockClaims = RED_MATURE, position = 1) => ({
  workflowId: WF,
  position,
  viewerUserId: VIEWER,
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

function expectNothingSpent(f: Fakes) {
  expect(f.reserveSpend).not.toHaveBeenCalled();
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

  it('unlocks: reserves the price, lifts the restriction, returns the url, adds no author share', async () => {
    const f = fakes([LOCKED, UNLOCKED]);
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('unlocked');
    expect(result.snapshot.outputs?.[1]).toStrictEqual({
      url: 'https://cdn/r1.png',
      nsfwLevel: 'r',
    });
    expect(result.charged).toStrictEqual({ unlockBuzz: UNLOCK_PRICE });
    expect(f.reserveSpend).toHaveBeenCalledWith(UNLOCK_PRICE);
    expect(f.refund).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('counts against the daily limit BEFORE the orchestrator is asked', async () => {
    const order: string[] = [];
    const f = fakes([LOCKED, UNLOCKED]);
    f.reserveSpend.mockImplementation(async () => {
      order.push('reserve');
      return { refund: f.refund };
    });
    f.liftRestriction.mockImplementation(async () => {
      order.push('lift');
    });
    await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(order).toStrictEqual(['reserve', 'lift']);
  });

  it('a daily-limit refusal returns refused and asks the orchestrator for nothing', async () => {
    const f = fakes([LOCKED], {
      reserveSpend: vi.fn<D['reserveSpend']>(async () => ({
        refused: 'app Buzz limit reached',
        errorCode: 'daily-limit-exceeded',
      })),
    });
    const result = await unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f);
    expect(result).toMatchObject({
      outcome: 'refused',
      message: 'app Buzz limit reached',
      errorCode: 'daily-limit-exceeded',
      charged: { unlockBuzz: 0 },
    });
    expect(result.snapshot.outputs?.[1]).toStrictEqual({ restricted: true, reason: 'pool' });
    expect(f.liftRestriction).not.toHaveBeenCalled();
  });

  it('refuses a total above the one the viewer confirmed, before reserving', async () => {
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
    // The plan read, the release check, the update's read-back and the re-classify: four reads.
    expect(OUTPUT_UNLOCK_LOCK_TTL_SECONDS * 1000).toBeGreaterThan(
      OUTPUT_UNLOCK_ORCHESTRATOR_TIMEOUT_MS + 4 * OUTPUT_UNLOCK_READ_TIMEOUT_MS
    );
  });
});

describe('refund paths: the reservation is returned', () => {
  it('the orchestrator refusing the unlock', async () => {
    const f = fakes([LOCKED], {
      liftRestriction: vi.fn<D['liftRestriction']>(async () => {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'insufficient yellow Buzz' });
      }),
    });
    const error = await rejection(unlockBlockOutput({ ...request(), expectedTotal: TOTAL }, f));
    expect(error.message).toBe('insufficient yellow Buzz');
    expect(f.refund).toHaveBeenCalledWith(TOTAL);
    // A failed unlock releases its lock.
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('the re-read after the unlock failing', async () => {
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
    expect(f.refund).toHaveBeenCalledWith(TOTAL);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('🔴 the unlock succeeding at the orchestrator but the output landing above the viewer ceiling', async () => {
    // The viewer allows up to R. Before the unlock the output was R ('pool'); the orchestrator's
    // read-back rates it X. The re-classification at the token ceiling must keep it restricted.
    const claims: OutputUnlockClaims = { ...RED_MATURE, viewerBrowsingLevel: UPTO_R };
    const f = fakes([
      LOCKED,
      () => workflow([image('pg0', 'pg'), image('r1', 'x')], { allowMatureContent: true }),
    ]);
    const result = await unlockBlockOutput({ ...request(claims), expectedTotal: TOTAL }, f);
    expect(result.outcome).toBe('not-released');
    expect(result.snapshot.outputs?.[1]).toStrictEqual({ restricted: true, reason: 'ceiling' });
    expect(JSON.stringify(result)).not.toContain('r1.png');
    expect(f.refund).toHaveBeenCalledWith(TOTAL);
    expect(result.charged).toStrictEqual({ unlockBuzz: 0 });
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
          output: { epochs: [{ epochNumber: 1, sampleImages: ['https://cdn/sample.png'] }] },
        },
      ],
    });
  /** An R output on an SFW app: the site sent `allowMatureContent: false` itself. */
  const sfwSiteRefused = () => workflow([image('r1', 'r')]);

  it('the SFW DOMAIN keeping a rated output out: link out to civitai.red, no charge', async () => {
    expect(planBlockOutputUnlock(sfwSiteRefused(), SFW_DOMAIN, 0)).toStrictEqual({
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
    const plan = planBlockOutputUnlock(unratedSample(), SFW_DOMAIN, 0);
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
    expect(planBlockOutputUnlock(lockedOnRed(), RED_VIEWER_SFW, 0)).toStrictEqual({
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
    expect(planBlockOutputUnlock(unratedSample(), RED_VIEWER_SFW, 0)).toStrictEqual({
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
