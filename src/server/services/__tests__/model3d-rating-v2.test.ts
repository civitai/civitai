import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  anglesMature,
  getModel3DPostBlock,
  model3DPostImages,
  model3dRatingV2Deps,
  rateModel3DByV2,
  clearStamp,
  MODEL3D_PREVIEW_PENDING,
  MODEL3D_PREVIEW_V2_GLOBAL_LIMIT,
  previewWindowKey,
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
      exclusive: async (_u, _w, op) => op(),
      clearPendingPreview: async () => undefined,
      takeRetry: async () => false,
      claimPreviewUser: async () => ({ refund: async () => undefined }),
      claimPreview: async () => 'window-1',
      releasePreview: async () => undefined,
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
      coverUrl: undefined,
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
        {
          user,
          req,
          primaryModel: glb,
          previewUrls: [hosted(0)],
          coverUrl: undefined,
          workflowId: 'wf-1',
        },
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
        {
          user,
          req,
          primaryModel: glb,
          previewUrls: five,
          coverUrl: undefined,
          workflowId: 'wf-1',
        },
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
      {
        user,
        req,
        primaryModel: glb,
        previewUrls: fourAngles,
        coverUrl: undefined,
        workflowId: 'wf-9',
      },
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
    const base = {
      primaryModel: glb,
      user,
      req,
      previewUrls: [hosted(0)],
      coverUrl: undefined,
      workflowId: 'wf-1',
    };
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
          coverUrl: undefined,
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
        coverUrl: undefined,
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
      claimPreview: async () => null,
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
        coverUrl: undefined,
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
          coverUrl: undefined,
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

  it('a failed read of a render asked for refuses the post until the expiry, then falls back', async () => {
    const readPreview = async () => Promise.reject(new Error('orchestrator down'));
    const fresh = deps([false], {
      pendingPreview: async () => ({ workflowId: 'pv-1', at: 1_000_000 - 1000 }),
      readPreview,
    });
    expect(await post(fresh.deps)).toBe(MODEL3D_PREVIEW_PENDING);
    expect(fresh.rate).not.toHaveBeenCalled();
    const old = deps([true], {
      pendingPreview: async () => ({
        workflowId: 'pv-1',
        at: 1_000_000 - PREVIEW_EXPIRY_SECONDS * 1000 - 1,
      }),
      readPreview,
    });
    expect(await post(old.deps)).toMatch(/rated mature/);
    expect(old.rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual([hosted(0)]);
  });

  it("the user's own render limit is claimed before the shared window, and its refusal blocks the post", async () => {
    const order: string[] = [];
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>();
    const { rate, deps: d } = deps([false], {
      claimPreviewUser: async () => {
        order.push('user');
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'renders: slow down' });
      },
      claimPreview: async () => {
        order.push('global');
        return 'window-1';
      },
      submitPreview,
    });
    await expect(post(d)).rejects.toThrow('renders: slow down');
    expect(order).toEqual(['user']);
    expect(submitPreview).not.toHaveBeenCalled();
    expect(rate).not.toHaveBeenCalled();
  });

  it('a submit that throws gives its slot back to the window it was counted in', async () => {
    const releasePreview = vi.fn<Model3dRatingV2Deps['releasePreview']>(async () => undefined);
    let now = 1_000_000;
    const { deps: d } = deps([true], {
      now: () => now,
      claimPreview: async () => previewWindowKey(now),
      submitPreview: async () => {
        // The window rolls over while the submit is out.
        now += MODEL3D_PREVIEW_V2_GLOBAL_LIMIT.windowSeconds * 1000;
        throw new Error('orchestrator down');
      },
      releasePreview,
    });
    expect(await post(d)).toMatch(/rated mature/);
    expect(releasePreview).toHaveBeenCalledTimes(1);
    expect(releasePreview).toHaveBeenCalledWith(previewWindowKey(1_000_000));
    expect(releasePreview.mock.calls[0][0]).not.toBe(previewWindowKey(now));
  });

  it('a submit that returned keeps its slot', async () => {
    const releasePreview = vi.fn<Model3dRatingV2Deps['releasePreview']>(async () => undefined);
    const { deps: d } = deps([false], {
      submitPreview: async () => ({ workflowId: 'pv-1', state: { status: 'running' } }),
      setPendingPreview: async () => Promise.reject(new Error('redis down')),
      releasePreview,
    });
    expect(await post(d)).toBe(MODEL3D_PREVIEW_PENDING);
    expect(releasePreview).not.toHaveBeenCalled();
  });

  it('each window has its own key', () => {
    const day = MODEL3D_PREVIEW_V2_GLOBAL_LIMIT.windowSeconds * 1000;
    expect(previewWindowKey(5 * day)).toBe(previewWindowKey(6 * day - 1));
    expect(previewWindowKey(6 * day)).not.toBe(previewWindowKey(6 * day - 1));
  });

  it('an empty render is asked for once more, then the existing previews decide', async () => {
    const spent = new Set<string>();
    let entry: { workflowId: string; at: number } | null = {
      workflowId: 'pv-1',
      at: 1_000_000 - 1000,
    };
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>(async () => ({
      workflowId: 'pv-2',
      state: { status: 'running' },
    }));
    const takeRetry = vi.fn<Model3dRatingV2Deps['takeRetry']>(async (u, w) =>
      spent.has(`${u}:${w}`) ? false : !!spent.add(`${u}:${w}`)
    );
    const store = {
      pendingPreview: async () => entry,
      setPendingPreview: async (
        _u: number,
        _w: string,
        value: { workflowId: string; at: number }
      ) => {
        entry = value;
      },
      clearPendingPreview: async () => {
        entry = null;
      },
      readPreview: async () => ({ status: 'done' as const, urls: [] }),
      takeRetry,
      submitPreview,
    };
    expect(await post(deps([], store).deps)).toBe(MODEL3D_PREVIEW_PENDING);
    expect(submitPreview).toHaveBeenCalledTimes(1);
    expect(entry).toEqual({ workflowId: 'pv-2', at: 1_000_000 });
    const later = deps([true], store);
    expect(await post(later.deps)).toMatch(/rated mature/);
    expect(submitPreview).toHaveBeenCalledTimes(1);
    expect(later.rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual([hosted(0)]);
  });

  it('a click while another is asking claims nothing and submits nothing', async () => {
    const claimPreviewUser = vi.fn<Model3dRatingV2Deps['claimPreviewUser']>(async () => ({
      refund: async () => undefined,
    }));
    const claimPreview = vi.fn<Model3dRatingV2Deps['claimPreview']>(async () => 'window-1');
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>();
    const busy = deps([], {
      exclusive: async () => null,
      claimPreviewUser,
      claimPreview,
      submitPreview,
    });
    expect(await post(busy.deps)).toBe(MODEL3D_PREVIEW_PENDING);
    expect(claimPreviewUser).not.toHaveBeenCalled();
    expect(claimPreview).not.toHaveBeenCalled();
    expect(submitPreview).not.toHaveBeenCalled();
  });

  it('a click that gets the lock after another asked reads that render instead of asking again', async () => {
    let reads = 0;
    const submitPreview = vi.fn<Model3dRatingV2Deps['submitPreview']>();
    const claimPreviewUser = vi.fn<Model3dRatingV2Deps['claimPreviewUser']>(async () => ({
      refund: async () => undefined,
    }));
    const { deps: d } = deps([], {
      // Empty on the first read, then the other click's entry inside the lock.
      pendingPreview: async () => (reads++ === 0 ? null : { workflowId: 'pv-1', at: 1_000_000 }),
      submitPreview,
      claimPreviewUser,
    });
    expect(await post(d)).toBe(MODEL3D_PREVIEW_PENDING);
    expect(submitPreview).not.toHaveBeenCalled();
    expect(claimPreviewUser).not.toHaveBeenCalled();
  });

  it.each([
    ['the global window refuses', { claimPreview: async () => null }],
    ['the submit throws', { submitPreview: async () => Promise.reject(new Error('down')) }],
  ])("when %s, the user's own render is given back", async (_, overrides) => {
    const refund = vi.fn(async () => undefined);
    const { deps: d } = deps([true], { claimPreviewUser: async () => ({ refund }), ...overrides });
    expect(await post(d)).toMatch(/rated mature/);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('a lock that cannot be taken because the store is down falls back instead of waiting', async () => {
    let reads = 0;
    const { rate, deps: d } = deps([true], {
      exclusive: async () => null,
      pendingPreview: async () => {
        if (reads++ === 0) return null;
        throw new Error('redis down');
      },
    });
    expect(await post(d)).toMatch(/rated mature/);
    expect(rate.mock.calls[0][0].items.map((i) => i.mediaUrl)).toEqual([hosted(0)]);
  });

  // No render back falls to the renders the result already has; never a pass on no rating at all.
  it.each([
    ['the render failed', {}],
    ['the global window refused', { claimPreview: async () => null }],
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

// The store the gate keeps its windows, retries and claims in, over the shared Redis double.
describe('the four-angle render store', () => {
  const store = new Map<string, number | string>();
  beforeEach(() => {
    store.clear();
    redisMock.redis.incrBy.mockImplementation(async (key: string, by: number) => {
      const next = Number(store.get(key) ?? 0) + by;
      store.set(key, next);
      return next;
    });
    redisMock.redis.ttl.mockImplementation(async (key: string) => (store.has(key) ? 100 : -2));
    redisMock.redis.expire.mockResolvedValue(true);
    redisMock.redis.del.mockImplementation(async (key: string) => Number(store.delete(key)));
    redisMock.redis.set.mockImplementation(
      async (key: string, value: string, opts?: { NX?: boolean }) => {
        if (opts?.NX && store.has(key)) return null;
        store.set(key, value);
        // The wrapper's SET answers '1' when it wrote, null when NX found the key.
        return '1';
      }
    );
  });

  it('claims a slot in the window it is in, refuses past the cap, and gives it back there', async () => {
    const key = await model3dRatingV2Deps.claimPreview();
    expect(key).toBe(previewWindowKey(Date.now()));
    store.set(key!, MODEL3D_PREVIEW_V2_GLOBAL_LIMIT.max);
    expect(await model3dRatingV2Deps.claimPreview()).toBeNull();
    store.set(key!, 3);
    await model3dRatingV2Deps.releasePreview(key!);
    expect(store.get(key!)).toBe(2);
  });

  it('a slot given back to a window that has gone leaves no key behind', async () => {
    await model3dRatingV2Deps.releasePreview('model3d:preview-v2:global:1');
    expect(store.has('model3d:preview-v2:global:1')).toBe(false);
  });

  it('a result gets one retry per user', async () => {
    expect(await model3dRatingV2Deps.takeRetry(7, 'wf-1')).toBe(true);
    expect(await model3dRatingV2Deps.takeRetry(7, 'wf-1')).toBe(false);
    expect(await model3dRatingV2Deps.takeRetry(8, 'wf-1')).toBe(true);
  });
});
