import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as InputUrls from '~/server/services/generation-input-urls';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';

const h = vi.hoisted(() => ({
  images: new Map<number, Record<string, unknown> & { ownerId: number }>(),
  generateFromGraph: vi.fn(async () => ({ id: 'wf-1', cost: { total: 30 } })),
  whatIfFromGraph: vi.fn(async () => ({ cost: { total: 30 }, ready: true })),
  assertInputs: vi.fn(async () => undefined),
  cache: new Map<string, unknown>(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  // Stands in for the visibility SQL: a hidden image is one owned by someone else.
  getImage: vi.fn(async ({ id, userId }: { id: number; userId?: number }) => {
    const image = h.images.get(id);
    if (!image || image.ownerId !== userId)
      throw new TRPCError({ code: 'NOT_FOUND', message: `No image with id ${id}` });
    return image;
  }),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNew>()),
  buildGenerationContext: vi.fn(async () => ({ externalCtx: {}, status: {} })),
  generateFromGraph: h.generateFromGraph,
  whatIfFromGraph: h.whatIfFromGraph,
  bustQueriedWorkflowsCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<typeof InputUrls>()),
  assertGenerationInputsUsable: h.assertInputs,
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
    if (!h.cache.has(key)) h.cache.set(key, await fn());
    return h.cache.get(key);
  }),
}));

import {
  buildRemixAppRun,
  quoteRemixApp,
  runRemixApp,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import {
  getSystemRemixApp,
  type RemixAppDefinition,
} from '~/shared/constants/remix-apps.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';

const USER_ID = 42;
const SAFE = 1;
const MATURE = 8;

function addImage(id: number, over: Record<string, unknown> = {}) {
  h.images.set(id, {
    id,
    ownerId: USER_ID,
    url: `ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c${String(id).padStart(2, '0')}`,
    type: 'image',
    nsfwLevel: SAFE,
    width: 1200,
    height: 800,
    ingestion: 'Scanned',
    blockedFor: null,
    minor: false,
    poi: false,
    ...over,
  });
}

const caller = (over: Partial<RemixAppCaller> = {}): RemixAppCaller => ({
  user: { id: USER_ID, isModerator: false, tier: 'free' } as RemixAppCaller['user'],
  token: 'token',
  features: { isGreen: false } as RemixAppCaller['features'],
  isGreenDomain: false,
  isApiCaller: false,
  ...over,
});

type SubmitArgs = { input: Record<string, unknown>; externalId?: string; remixOfId?: number };
const submitted = () =>
  (h.generateFromGraph.mock.calls as unknown as [SubmitArgs][]).map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  h.images.clear();
  h.cache.clear();
});

describe('remixApp.run → graph input', () => {
  it('runs a safe source on the Edit safe engine with the source aspect snapped', async () => {
    addImage(1, { width: 1200, height: 800 });
    await runRemixApp({ slug: 'anime-it', imageId: 1, nonce: 'nonce-0001', caller: caller() });

    const [args] = submitted();
    expect(args.input).toMatchObject({
      ecosystem: REMIX_ENGINES.edit.safe.ecosystemKey,
      model: { id: REMIX_ENGINES.edit.safe.modelVersionId },
      aspectRatio: '3:2',
      quantity: 1,
      prompt: getSystemRemixApp('anime-it')!.prompt,
    });
    expect((args.input.images as { url: string }[])[0].url).toContain(h.images.get(1)!.url);
    expect(args.remixOfId).toBe(1);
    expect((args as unknown as { tags: string[] }).tags).toContain('remix-app:anime-it');
  });

  it('switches a mature source to the Edit mature engine', async () => {
    addImage(2, { nsfwLevel: MATURE, width: 800, height: 1400 });
    await runRemixApp({ slug: 'pixel-art', imageId: 2, nonce: 'nonce-0002', caller: caller() });

    expect(submitted()[0].input).toMatchObject({
      ecosystem: REMIX_ENGINES.edit.mature.ecosystemKey,
      model: { id: REMIX_ENGINES.edit.mature.modelVersionId },
      aspectRatio: '9:16',
    });
  });

  it('refuses a mature source on an app with no mature engine, before any submit', () => {
    addImage(3, { nsfwLevel: MATURE });
    const safeOnly: RemixAppDefinition = {
      ...getSystemRemixApp('anime-it')!,
      engine: { safe: getSystemRemixApp('anime-it')!.engine.safe },
    };
    expect(() =>
      buildRemixAppRun({ app: safeOnly, image: h.images.get(3) as never, isGreen: false })
    ).toThrow(/does not run on mature/);
  });

  it('refuses a mature source on the green domain', async () => {
    addImage(4, { nsfwLevel: MATURE });
    await expect(
      runRemixApp({
        slug: 'anime-it',
        imageId: 4,
        nonce: 'nonce-0004',
        caller: caller({ isGreenDomain: true }),
      })
    ).rejects.toThrow(/Mature images cannot be remixed/);
    expect(h.generateFromGraph).not.toHaveBeenCalled();
  });

  it('refuses an image the caller cannot see, and submits nothing', async () => {
    addImage(5, { ownerId: USER_ID + 1 });
    await expect(
      runRemixApp({ slug: 'anime-it', imageId: 5, nonce: 'nonce-0005', caller: caller() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.generateFromGraph).not.toHaveBeenCalled();
  });

  it('refuses a source the input gate rejects', async () => {
    addImage(6);
    h.assertInputs.mockRejectedValueOnce(new TRPCError({ code: 'BAD_REQUEST', message: 'gate' }));
    await expect(
      runRemixApp({ slug: 'anime-it', imageId: 6, nonce: 'nonce-0006', caller: caller() })
    ).rejects.toThrow('gate');
    expect(h.generateFromGraph).not.toHaveBeenCalled();
  });

  it('sends the same externalId for a double tap, and a new one for a new tap', async () => {
    addImage(7);
    const tap = (nonce: string) =>
      runRemixApp({ slug: 'anime-it', imageId: 7, nonce, caller: caller() });
    await tap('nonce-aaaa');
    await tap('nonce-aaaa');
    await tap('nonce-bbbb');

    const [first, again, other] = submitted().map((a) => a.externalId);
    expect(first).toBeTruthy();
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe('remixApp.quote', () => {
  it('prices the same input the run submits', async () => {
    addImage(8, { nsfwLevel: MATURE });
    await quoteRemixApp({ slug: 'toy-figure', imageId: 8, caller: caller() });
    await runRemixApp({ slug: 'toy-figure', imageId: 8, nonce: 'nonce-0008', caller: caller() });

    const quoted = (h.whatIfFromGraph.mock.calls as unknown as [SubmitArgs][])[0][0].input;
    expect(quoted).toEqual(submitted()[0].input);
  });

  it('reuses a cached price within a bucket and re-prices across tiers', async () => {
    addImage(9, { width: 1200, height: 800 });
    addImage(10, { width: 1210, height: 800 });
    addImage(11, { width: 1200, height: 800, nsfwLevel: MATURE });
    await quoteRemixApp({ slug: 'anime-it', imageId: 9, caller: caller() });
    await quoteRemixApp({ slug: 'anime-it', imageId: 10, caller: caller() });
    expect(h.whatIfFromGraph).toHaveBeenCalledTimes(1);

    await quoteRemixApp({ slug: 'anime-it', imageId: 11, caller: caller() });
    expect(h.whatIfFromGraph).toHaveBeenCalledTimes(2);
  });
});
