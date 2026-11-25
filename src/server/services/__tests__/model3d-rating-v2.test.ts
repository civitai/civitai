import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import {
  anglesMature,
  getModel3DPostBlock,
  model3DPostImages,
  rateModel3DByV2,
  clearStamp,
  MODEL3D_PREVIEW_PENDING,
  MODEL3D_RATING_V2_GLOBAL_LIMIT,
  PREVIEW_EXPIRY_SECONDS,
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
      rememberedClear: async () => null,
      rememberClear: async () => undefined,
      pendingPreview: async () => null,
      setPendingPreview: async () => undefined,
      claimPreview: async () => true,
      submitPreview: async () => ({ workflowId: 'pv-1', state: { status: 'done', urls: [] } }),
      readPreview: async () => ({ status: 'done', urls: [] }),
      now: () => 1_000_000,
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

// The v2 rater can only add a post block for a 3D result, never clear one.
describe('3D post gate with the v2 rater', () => {
  it('blocks a result without mature billing when one of four angles is mature', async () => {
    expect(await gate([false, false, true, false])).toMatch(/rated mature/);
  });

  it('a block from the v2 rater alone offers no Yellow Buzz unlock', async () => {
    const block = await gate([true], [hosted(0)]);
    expect(block).toMatch(/rated mature/);
    expect(block).not.toMatch(/Yellow Buzz|[Uu]nlock/);
  });

  it('works with a single preview angle', async () => {
    expect(await gate([true], [hosted(0)])).toMatch(/rated mature/);
    expect(await gate([false], [hosted(0)])).toBeUndefined();
  });

  it('a mature angle blocks even when another angle has no verdict', async () => {
    expect(await gate([true, null, false, false])).toMatch(/rated mature/);
    expect(await gate([null, null, false, false])).toBeUndefined();
  });

  it('flag off or a full global window keeps the current rating', async () => {
    expect(
      await gate([true, true, true, true], fourAngles, { matureLevel: async () => null })
    ).toBeUndefined();
    expect(
      await gate([true, true, true, true], fourAngles, { claim: async () => false })
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
      await rateModel3DByV2(
        { user, req, primaryModel: glb, previewUrls: [hosted(0)], workflowId: 'wf-1' },
        d
      )
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
    expect(
      await rateModel3DByV2(
        { user, req, primaryModel: glb, previewUrls: five, workflowId: 'wf-1' },
        d
      )
    ).toBe('mature');
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
    await rateModel3DByV2(
      { user, req, primaryModel: glb, previewUrls: fourAngles, workflowId: 'wf-9' },
      d
    );
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
        {
          user,
          req,
          primaryModel: glb,
          previewUrls: [hosted(0), 'https://example.com/x.png'],
          workflowId: 'wf-1',
        },
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
  it('any mature angle counts; no verdict adds nothing', () => {
    expect(anglesMature([])).toBe(false);
    expect(anglesMature([false, null])).toBe(false);
    expect(anglesMature([false, true])).toBe(true);
    expect(anglesMature([null, true])).toBe(true);
  });
});

// A GLB or PLY result is rated from its own four-angle render, asked for on the system token. While the
// render runs the post is refused; when none of it comes back, the renders the result has decide.
describe('3D post gate with a four-angle render', () => {
  const mesh = {
    format: 'glb',
    url: 'https://orchestration.civitai.com/v2/consumer/blobs/MESH-0.glb?sig=a&exp=2026-11-26T00:00:00Z',
  };
  const rendered = [10, 11, 12, 13, 14].map(hosted);
  const post = (d: Model3dRatingV2Deps, primaryModel: { format: string; url?: string } = mesh) =>
    getModel3DPostBlock(
      {
        primaryModel,
        effectiveNsfwLevel: 'pg' as never,
        allowMatureContent: false,
        user,
        req,
        previewUrls: [hosted(0)],
        workflowId: 'wf-1',
      },
      d
    );

  it("rates the render of the result's own mesh, not the existing previews", async () => {
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>(async () => ({
      workflowId: 'pv-1',
      state: { status: 'done', urls: rendered.slice(0, 4) },
    }));
    const { rate, deps: d } = deps([false, false, false, true], { submitPreview });
    expect(await post(d)).toMatch(/rated mature/);
    expect(submitPreview).toHaveBeenCalledWith({ url: mesh.url, format: 'glb' }, expect.anything());
    expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual(rendered.slice(0, 4));
  });

  it('rates only the first four angles that came back, and as few as came back', async () => {
    const five = deps([false, false, false, false, true], {
      submitPreview: async () => ({
        workflowId: 'pv-1',
        state: { status: 'done', urls: rendered },
      }),
    });
    expect(await post(five.deps)).toBeUndefined();
    expect(five.rate.mock.calls[0][0].items).toHaveLength(4);
    const two = deps([false, true], {
      submitPreview: async () => ({
        workflowId: 'pv-1',
        state: { status: 'done', urls: rendered.slice(0, 2) },
      }),
    });
    expect(await post(two.deps)).toMatch(/rated mature/);
    expect(two.rate.mock.calls[0][0].items).toHaveLength(2);
  });

  it('a render still running refuses the post, remembers it, and rates nothing', async () => {
    const setPendingPreview = vi.fn<Model3dRatingV2Deps['setPendingPreview']>(
      async () => undefined
    );
    const { rate, deps: d } = deps([false], {
      submitPreview: async () => ({ workflowId: 'pv-1', state: { status: 'running' } }),
      setPendingPreview,
    });
    const block = await post(d);
    expect(block).toBe(MODEL3D_PREVIEW_PENDING);
    expect(block).not.toMatch(/rat(ed|ing)|classif/i);
    expect(setPendingPreview).toHaveBeenCalledWith(7, 'wf-1', {
      workflowId: 'pv-1',
      at: 1_000_000,
    });
    expect(rate).not.toHaveBeenCalled();
  });

  it('a later click reads the render it asked for instead of asking again', async () => {
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>();
    const readPreview = vi.fn<Model3dRatingV2Deps['readPreview']>(async () => ({
      status: 'running',
    }));
    const pendingPreview = vi.fn<Model3dRatingV2Deps['pendingPreview']>(async () => ({
      workflowId: 'pv-1',
      at: 1_000_000 - 1000,
    }));
    const { deps: d } = deps([], { submitPreview, readPreview, pendingPreview });
    expect(await post(d)).toBe(MODEL3D_PREVIEW_PENDING);
    expect(pendingPreview).toHaveBeenCalledWith(7, 'wf-1');
    expect(readPreview).toHaveBeenCalledWith('pv-1');
    expect(submitPreview).not.toHaveBeenCalled();
  });

  it('a later click on a finished render rates it without asking again', async () => {
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>();
    const { rate, deps: d } = deps([false, true], {
      submitPreview,
      pendingPreview: async () => ({ workflowId: 'pv-1', at: 1_000_000 - 1000 }),
      readPreview: async () => ({ status: 'done', urls: rendered.slice(0, 2) }),
    });
    expect(await post(d)).toMatch(/rated mature/);
    expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual(rendered.slice(0, 2));
    expect(submitPreview).not.toHaveBeenCalled();
  });

  it('a finished render with only media the orchestrator does not host rates the existing previews', async () => {
    const { rate, deps: d } = deps([true], {
      submitPreview: async () => ({
        workflowId: 'pv-1',
        state: { status: 'done', urls: ['https://example.com/x.png'] },
      }),
    });
    expect(await post(d)).toMatch(/rated mature/);
    expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual([hosted(0)]);
  });

  it('a refused global window asks for no render', async () => {
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>();
    const setPendingPreview = vi.fn<Model3dRatingV2Deps['setPendingPreview']>();
    const { deps: d } = deps([false], {
      claimPreview: async () => false,
      submitPreview,
      setPendingPreview,
    });
    await post(d);
    expect(submitPreview).not.toHaveBeenCalled();
    expect(setPendingPreview).not.toHaveBeenCalled();
  });

  it('a render that finished is rated however long ago it was asked for', async () => {
    const { rate, deps: d } = deps([true], {
      pendingPreview: async () => ({
        workflowId: 'pv-1',
        at: 1_000_000 - PREVIEW_EXPIRY_SECONDS * 1000 * 10,
      }),
      readPreview: async () => ({ status: 'done', urls: rendered.slice(0, 1) }),
    });
    expect(await post(d)).toMatch(/rated mature/);
    expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual(rendered.slice(0, 1));
  });

  it("every rating of a render claims the limits; asking for the render claims none of the user's", async () => {
    const claim = vi.fn<Model3dRatingV2Deps['claim']>(async () => true);
    const first = deps([false], {
      claim,
      submitPreview: async () => ({ workflowId: 'pv-1', state: { status: 'running' } }),
    });
    expect(await post(first.deps)).toBe(MODEL3D_PREVIEW_PENDING);
    expect(claim).not.toHaveBeenCalled();
    const later = deps([false, false, false, false, false], {
      claim,
      pendingPreview: async () => ({ workflowId: 'pv-1', at: 1_000_000 }),
      readPreview: async () => ({ status: 'done', urls: rendered.slice(0, 4) }),
    });
    expect(await post(later.deps)).toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(later.rate).toHaveBeenCalledTimes(1);
  });

  it('a clear verdict on the same images is kept, so repeat passes call the rater once', async () => {
    let kept: string | null = null;
    const claim = vi.fn<Model3dRatingV2Deps['claim']>(async () => true);
    const { rate, deps: d } = deps([false, false, false, false, false], {
      claim,
      rememberedClear: async () => kept,
      rememberClear: async (_u, _w, rated) => {
        kept = rated;
      },
      pendingPreview: async () => ({ workflowId: 'pv-1', at: 1_000_000 }),
      readPreview: async () => ({ status: 'done', urls: rendered.slice(0, 4) }),
    });
    for (let i = 0; i < 3; i++) expect(await post(d)).toBeUndefined();
    expect(rate).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('a clear verdict is not kept when an image had none, nor reused for other images', async () => {
    const rememberClear = vi.fn<Model3dRatingV2Deps['rememberClear']>(async () => undefined);
    const partial = deps([false, null], {
      rememberClear,
      submitPreview: async () => ({ workflowId: 'pv-1', state: { status: 'done', urls: [] } }),
    });
    await getModel3DPostBlock(
      {
        primaryModel: glb,
        effectiveNsfwLevel: 'pg' as never,
        allowMatureContent: false,
        user,
        req,
        previewUrls: [hosted(0), hosted(1)],
        workflowId: 'wf-1',
      },
      partial.deps
    );
    expect(rememberClear).not.toHaveBeenCalled();
    const other = deps([true], { rememberedClear: async () => clearStamp(2, [hosted(9)]) });
    expect(await post(other.deps)).toMatch(/rated mature/);
  });

  it('a clear verdict kept at one level is rated again when the level tightens', async () => {
    let kept: string | null = null;
    let level = 3;
    const store = {
      matureLevel: async () => level,
      rememberedClear: async () => kept,
      rememberClear: async (_u: number, _w: string, stamp: string) => {
        kept = stamp;
      },
    };
    expect(await gate([false], [hosted(0)], store)).toBeUndefined();
    level = 2;
    const { rate, deps: d } = deps([true], store);
    expect(
      await getModel3DPostBlock(
        {
          primaryModel: glb,
          effectiveNsfwLevel: 'pg' as never,
          allowMatureContent: false,
          user,
          req,
          previewUrls: [hosted(0)],
          workflowId: 'wf-1',
        },
        d
      )
    ).toMatch(/rated mature/);
    expect(rate).toHaveBeenCalledTimes(1);
  });

  it('the cover is rated with the render angles: a mature cover over clear angles is mature', async () => {
    const cover = hosted(0);
    const { rate, deps: d } = deps([false, false, false, false, true], {
      submitPreview: async () => ({
        workflowId: 'pv-1',
        state: { status: 'done', urls: rendered.slice(0, 4) },
      }),
    });
    expect(
      await getModel3DPostBlock(
        {
          primaryModel: mesh,
          effectiveNsfwLevel: 'pg' as never,
          allowMatureContent: false,
          user,
          req,
          previewUrls: [cover],
          coverUrl: cover,
          workflowId: 'wf-1',
        },
        d
      )
    ).toMatch(/rated mature/);
    expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual([
      ...rendered.slice(0, 4),
      cover,
    ]);
  });

  it("the user's own limit refusing blocks the post when the render is rated", async () => {
    const { rate, deps: d } = deps([false], {
      claim: async () => {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'slow down' });
      },
      submitPreview: async () => ({
        workflowId: 'pv-1',
        state: { status: 'done', urls: rendered.slice(0, 4) },
      }),
    });
    await expect(post(d)).rejects.toThrow('slow down');
    expect(rate).not.toHaveBeenCalled();
  });

  // No render back falls to the renders the result already has; never a pass on no rating at all.
  it.each([
    ['the render failed', {}],
    ['the global window refused', { claimPreview: async () => false }],
    ['the submit threw', { submitPreview: async () => Promise.reject(new Error('down')) }],
    [
      'the render expired',
      {
        pendingPreview: async () => ({
          workflowId: 'pv-1',
          at: 1_000_000 - PREVIEW_EXPIRY_SECONDS * 1000 - 1,
        }),
        readPreview: async () => ({ status: 'running' as const }),
      },
    ],
  ])('when %s, the existing previews are rated', async (_, overrides) => {
    const { rate, deps: d } = deps([true], overrides);
    expect(await post(d)).toMatch(/rated mature/);
    expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual([hosted(0)]);
  });

  it('FBX, or a mesh the orchestrator does not host, keeps the existing previews and asks nothing', async () => {
    for (const primaryModel of [
      { format: 'fbx', url: mesh.url },
      { format: 'glb', url: 'https://example.com/x.glb' },
      { format: 'glb' },
    ]) {
      const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>();
      const { rate, deps: d } = deps([true], { submitPreview });
      expect(await post(d, primaryModel)).toMatch(/rated mature/);
      expect(submitPreview).not.toHaveBeenCalled();
      expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual([hosted(0)]);
    }
  });

  it('flag off asks for no render', async () => {
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>();
    const { deps: d } = deps([], { matureLevel: async () => null, submitPreview });
    expect(await post(d)).toBeUndefined();
    expect(submitPreview).not.toHaveBeenCalled();
  });
});
