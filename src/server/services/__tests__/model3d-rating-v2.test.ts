import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import {
  anglesMature,
  getModel3DPostBlock,
  model3DPostImages,
  rateModel3DByV2,
  MODEL3D_RATING_V2_GLOBAL_LIMIT,
  MODEL3D_RATING_V2_RATE_LIMIT,
  type Model3dRatingV2Deps,
} from '~/server/services/model3d-rating-v2.service';
import {
  STUDIO_DATASET_RATING_GLOBAL_LIMIT,
  STUDIO_DATASET_RATING_RATE_LIMIT,
} from '~/server/services/training-studio-dataset-rating.service';
import type { SessionUser } from '~/types/session';

const clientEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT: 'https://orchestration.civitai.com',
}));
vi.mock('~/env/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  env: clientEnv,
}));

const user = { id: 7 } as SessionUser;
const req = {} as NextApiRequest;
const hosted = (i: number) =>
  `https://orchestration.civitai.com/v2/consumer/blobs/PREVIEW${i}-0.png?sig=a&exp=2026-11-26T00:00:00Z`;
const fourAngles = [0, 1, 2, 3].map(hosted);

/** The v2 rater answering one verdict per angle, in order. */
function deps(verdicts: (boolean | null)[], overrides: Partial<Model3dRatingV2Deps> = {}) {
  const rate = vi.fn<Model3dRatingV2Deps['rate']>(async ({ items }) =>
    items.map((item, i) => ({ key: item.key, mature: verdicts[i] ?? null }))
  );
  return {
    rate,
    deps: {
      matureLevel: async () => 2,
      claim: async () => true,
      rate,
      remembered: async () => false,
      remember: async () => undefined,
      ...overrides,
    } satisfies Model3dRatingV2Deps,
  };
}

const glb = { format: 'glb' } as const;
const gate = (verdicts: (boolean | null)[], previewUrls = fourAngles, overrides = {}) =>
  getModel3DPostBlock(
    {
      primaryModel: glb,
      effectiveNsfwLevel: 'pg' as never,
      allowMatureContent: false,
      user,
      req,
      previewUrls,
      workflowId: 'wf-1',
    },
    deps(verdicts, overrides).deps
  );

// Justin, card 2026-11-25-200325: the v2 rater gates posting a 3D result (raise only).
describe('3D post gate with the v2 rater', () => {
  it('blocks a result without mature billing when one of four angles is mature', async () => {
    expect(await gate([false, false, true, false])).toMatch(/rated mature/);
  });

  it('works with a single preview angle', async () => {
    expect(await gate([true], [hosted(0)])).toMatch(/rated mature/);
    expect(await gate([false], [hosted(0)])).toBeUndefined();
  });

  it('a partly rated result keeps its current rating', async () => {
    expect(await gate([true, null, false, false])).toBeUndefined();
  });

  it('flag off, a refused limit or a rater failure keeps the current rating', async () => {
    expect(
      await gate([true, true, true, true], fourAngles, { matureLevel: async () => null })
    ).toBeUndefined();
    expect(
      await gate([true, true, true, true], fourAngles, { claim: async () => false })
    ).toBeUndefined();
    expect(
      await gate([true], [hosted(0)], { rate: async () => Promise.reject(new Error('down')) })
    ).toBeUndefined();
  });

  it('a throwing flag read or limit keeps the current rating, and spends nothing first', async () => {
    const claim = vi.fn(async () => true);
    expect(
      await gate([true], [hosted(0)], { matureLevel: async () => null, claim })
    ).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
    const { rate, deps: d } = deps([true], {
      claim: async () => Promise.reject(new Error('redis down')),
    });
    expect(
      await rateModel3DByV2({ user, req, previewUrls: [hosted(0)], workflowId: 'wf-1' }, d)
    ).toBe('clear');
    expect(rate).not.toHaveBeenCalled();
    expect(
      await gate([true], [hosted(0)], { matureLevel: async () => Promise.reject(new Error('x')) })
    ).toBeUndefined();
  });

  it('a mature verdict holds the gate on a later attempt that gets no v2 answer', async () => {
    const seen = new Set<string>();
    const memory = {
      remembered: async (id: string) => seen.has(id),
      remember: async (id: string) => void seen.add(id),
    };
    expect(await gate([true], [hosted(0)], memory)).toMatch(/rated mature/);
    expect(await gate([null], [hosted(0)], { ...memory, claim: async () => false })).toMatch(
      /rated mature/
    );
    // Rolled back (flag off): the remembered verdict no longer applies.
    expect(
      await gate([null], [hosted(0)], { ...memory, matureLevel: async () => null })
    ).toBeUndefined();
  });

  it('rates only the first four angles of a larger set', async () => {
    const { rate, deps: d } = deps([false, false, false, true, true]);
    const five = [0, 1, 2, 3, 4].map(hosted);
    expect(await rateModel3DByV2({ user, req, previewUrls: five, workflowId: 'wf-1' }, d)).toBe(
      'mature'
    );
    expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual(five.slice(0, 4));
  });

  it('a preview set the user controls and that cannot be rated refuses the post', async () => {
    expect(await gate([false], [])).toMatch(/couldn't be rated/);
    expect(await gate([false], [hosted(0), 'https://example.com/x.png'])).toMatch(
      /couldn't be rated/
    );
    // Flag off: nothing changes.
    expect(await gate([false], [], { matureLevel: async () => null })).toBeUndefined();
  });

  it("the user's own limit refusing blocks the post instead of letting it through", async () => {
    const refused = new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Slow down',
      cause: { rateLimit: { retryAfterSeconds: 60 } },
    });
    await expect(
      gate([false], [hosted(0)], { claim: async () => Promise.reject(refused) })
    ).rejects.toBe(refused);
  });

  it('a refusal without retry details blocks too; a store outage keeps the current rating', async () => {
    const bare = new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: "You're doing that too much...",
    });
    await expect(
      gate([false], [hosted(0)], { claim: async () => Promise.reject(bare) })
    ).rejects.toBe(bare);
    const outage = new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'try again' });
    expect(
      await gate([true], [hosted(0)], { claim: async () => Promise.reject(outage) })
    ).toBeUndefined();
  });

  it('a rater error still passes on the current rating', async () => {
    expect(
      await gate([true], [hosted(0)], { rate: async () => Promise.reject(new Error('rater down')) })
    ).toBeUndefined();
  });

  it('sends every angle once, keyed by position, at the flag level', async () => {
    const { rate, deps: d } = deps([false, false, false, false], { matureLevel: async () => 3 });
    await rateModel3DByV2({ user, req, previewUrls: fourAngles, workflowId: 'wf-9' }, d);
    expect(rate).toHaveBeenCalledTimes(1);
    const [args] = rate.mock.calls[0];
    expect(args.items.map((i) => i.key)).toEqual(['0', '1', '2', '3']);
    expect(args.items.map((i) => i.mediaUrl)).toEqual(fourAngles);
    expect(args.matureLevel).toBe(3);
    expect(args.metadata).toMatchObject({ workflowId: 'wf-9', userId: 7 });
  });

  it('is not asked when mature billing is on or the result is already mature', async () => {
    const { rate, deps: d } = deps([true]);
    const base = { primaryModel: glb, user, req, previewUrls: [hosted(0)], workflowId: 'wf-1' };
    expect(
      await getModel3DPostBlock(
        { ...base, effectiveNsfwLevel: 'pg' as never, allowMatureContent: true },
        d
      )
    ).toBeUndefined();
    expect(
      await getModel3DPostBlock(
        { ...base, effectiveNsfwLevel: 'r' as never, allowMatureContent: false },
        d
      )
    ).toMatch(/rated mature/);
    expect(rate).not.toHaveBeenCalled();
  });

  it('never sends media the orchestrator does not host', async () => {
    const { rate, deps: d } = deps([true]);
    expect(
      await rateModel3DByV2(
        { user, req, previewUrls: [hosted(0), 'https://example.com/x.png'], workflowId: 'wf-1' },
        d
      )
    ).toBe('unrateable');
    expect(rate).not.toHaveBeenCalled();
  });

  it("draws on its own limits, never the Training Studio's", () => {
    expect(MODEL3D_RATING_V2_RATE_LIMIT.key).not.toBe(STUDIO_DATASET_RATING_RATE_LIMIT.key);
    expect(MODEL3D_RATING_V2_GLOBAL_LIMIT.key).not.toBe(STUDIO_DATASET_RATING_GLOBAL_LIMIT.key);
  });
});

describe('model3DPostImages', () => {
  const thumb = { url: hosted(9) };
  it('with no preview render, rates exactly the thumbnail the post shows', () => {
    const { cover, ratedUrls, coverOverride } = model3DPostImages([], thumb);
    expect(coverOverride).toBeUndefined();
    expect(ratedUrls).toEqual([cover?.url]);
    expect(cover).toBe(thumb);
  });
  it('with renders, the cover is the first render and is rated', () => {
    const renders = [null, { url: hosted(0) }, { url: hosted(1) }];
    const { cover, ratedUrls } = model3DPostImages(renders, thumb);
    expect(cover?.url).toBe(hosted(0));
    expect(ratedUrls).toEqual([hosted(0), hosted(1)]);
  });
  it('a thumbnail with no image gives nothing to rate', () => {
    expect(model3DPostImages([], { url: null }).ratedUrls).toEqual([]);
  });
});

describe('anglesMature', () => {
  it('needs every angle rated', () => {
    expect(anglesMature([])).toBe(false);
    expect(anglesMature([false, false])).toBe(false);
    expect(anglesMature([false, true])).toBe(true);
    expect(anglesMature([null, true])).toBe(false);
  });
});
