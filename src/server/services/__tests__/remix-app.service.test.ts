import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as InputUrls from '~/server/services/generation-input-urls';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';

const h = vi.hoisted(() => ({
  images: new Map<
    number,
    Record<string, unknown> & { ownerId: number; hidden?: boolean; blocks?: number[] }
  >(),
  generateFromGraph: vi.fn(async () => ({ id: 'wf-1', cost: { total: 30 } })),
  whatIfFromGraph: vi.fn(async () => ({ cost: { total: 30 }, ready: true })),
  assertInputs: vi.fn(async () => undefined),
  cache: new Map<string, unknown>(),
}));

vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageVisibility>()),
  // Stands in for the visibility SQL and the owner-block check: a hidden image is visible to its
  // owner and to moderators, and an owner's block hides it from that viewer unless they moderate.
  assertImageVisibleToViewer: vi.fn(
    async ({ id, userId, isModerator }: { id: number; userId?: number; isModerator?: boolean }) => {
      const image = h.images.get(id);
      const notFound = new TRPCError({ code: 'NOT_FOUND', message: `No image with id ${id}` });
      if (!image) throw notFound;
      if (image.hidden && image.ownerId !== userId && !isModerator) throw notFound;
      if (userId && !isModerator && image.blocks?.includes(userId)) throw notFound;
      return { id, userId: image.ownerId, nsfwLevel: image.nsfwLevel, postId: null };
    }
  ),
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
  quoteRemixApps,
  runRemixApp,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import {
  getSystemRemixApp,
  SYSTEM_REMIX_APPS,
  type RemixAppDefinition,
} from '~/shared/constants/remix-apps.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';

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

const caller = (
  over: Partial<RemixAppCaller> = {},
  user: Partial<RemixAppCaller['user']> = {}
): RemixAppCaller => ({
  user: {
    id: USER_ID,
    isModerator: false,
    tier: 'free',
    showNsfw: true,
    ...user,
  } as RemixAppCaller['user'],
  token: 'token',
  features: { isGreen: false } as RemixAppCaller['features'],
  isGreenDomain: false,
  isApiCaller: false,
  ...over,
});

type SubmitArgs = {
  input: Record<string, unknown>;
  externalId?: string;
  remixOfId?: number;
  tags: string[];
  allowMatureContent?: boolean;
};
const submitted = () =>
  (h.generateFromGraph.mock.calls as unknown as [SubmitArgs][]).map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => h.images.get(where.id) ?? null
  );
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
    expect(args.tags).toContain('remix-app:anime-it');
    expect(args.allowMatureContent).toBeUndefined();
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
      buildRemixAppRun({
        app: safeOnly,
        image: h.images.get(3) as never,
        viewer: { isGreen: false, showNsfw: true },
      })
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
    addImage(5, { ownerId: USER_ID + 1, hidden: true });
    await expect(
      runRemixApp({ slug: 'anime-it', imageId: 5, nonce: 'nonce-0005', caller: caller() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.generateFromGraph).not.toHaveBeenCalled();

    // Control: the same image is visible to a moderator, so the refusal above is visibility.
    await runRemixApp({
      slug: 'anime-it',
      imageId: 5,
      nonce: 'nonce-0005',
      caller: caller({}, { isModerator: true }),
    });
    expect(h.generateFromGraph).toHaveBeenCalledTimes(1);
  });

  it('refuses an image whose owner blocked the caller', async () => {
    addImage(12, { ownerId: USER_ID + 1, blocks: [USER_ID] });
    await expect(
      runRemixApp({ slug: 'anime-it', imageId: 12, nonce: 'nonce-0012', caller: caller() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(quoteRemixApps({ imageId: 12, caller: caller() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.generateFromGraph).not.toHaveBeenCalled();
    expect(h.whatIfFromGraph).not.toHaveBeenCalled();
  });

  it('refuses a mature source for a viewer with mature content off', async () => {
    addImage(13, { nsfwLevel: MATURE });
    await expect(
      runRemixApp({
        slug: 'anime-it',
        imageId: 13,
        nonce: 'nonce-0013',
        caller: caller({}, { showNsfw: false }),
      })
    ).rejects.toThrow(/Turn on mature content/);
    expect(h.generateFromGraph).not.toHaveBeenCalled();
  });

  it('caps the output for a viewer with mature content off', async () => {
    addImage(14);
    await runRemixApp({
      slug: 'anime-it',
      imageId: 14,
      nonce: 'nonce-0014',
      caller: caller({}, { showNsfw: false }),
    });
    expect(submitted()[0].allowMatureContent).toBe(false);
  });

  it('tags and caps a green-domain run of a safe source', async () => {
    addImage(15);
    await runRemixApp({
      slug: 'anime-it',
      imageId: 15,
      nonce: 'nonce-0015',
      caller: caller({ isGreenDomain: true }),
    });
    const [args] = submitted();
    expect(args.allowMatureContent).toBe(false);
    expect(args.tags).toEqual(expect.arrayContaining(['green', 'remix-app:anime-it']));
  });

  it('sends a video source as its first frame, not the mp4', async () => {
    addImage(16, { type: 'video' });
    await runRemixApp({ slug: 'anime-it', imageId: 16, nonce: 'nonce-0016', caller: caller() });
    const url = (submitted()[0].input.images as { url: string }[])[0].url;
    expect(url).toContain('transcode=true');
    expect(url).not.toContain('original=true');
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
  const whatIfInputs = () =>
    (h.whatIfFromGraph.mock.calls as unknown as [SubmitArgs][]).map((c) => c[0].input);

  it('prices the same input the run submits', async () => {
    addImage(8, { nsfwLevel: MATURE });
    await quoteRemixApps({ imageId: 8, caller: caller() });
    await runRemixApp({ slug: 'toy-figure', imageId: 8, nonce: 'nonce-0008', caller: caller() });

    expect(whatIfInputs()).toContainEqual(submitted()[0].input);
  });

  it('prices every app from one source load', async () => {
    addImage(17);
    const { prices } = await quoteRemixApps({ imageId: 17, caller: caller() });
    expect(prices.map((p) => p.slug)).toEqual(SYSTEM_REMIX_APPS.map((a) => a.slug));
    expect(prices.every((p) => 'cost' in p && p.cost === 30)).toBe(true);
    expect(h.assertInputs).toHaveBeenCalledTimes(1);
  });

  it('reuses a cached price only when nothing the price depends on differs', async () => {
    const perOpen = SYSTEM_REMIX_APPS.length;
    addImage(9, { width: 1200, height: 800 });
    addImage(10, { width: 1210, height: 800 });
    await quoteRemixApps({ imageId: 9, caller: caller() });
    await quoteRemixApps({ imageId: 10, caller: caller() });
    expect(h.whatIfFromGraph).toHaveBeenCalledTimes(perOpen);

    addImage(11, { width: 1200, height: 800, nsfwLevel: MATURE });
    addImage(18, { width: 800, height: 1200 });
    const variants: [number, RemixAppCaller][] = [
      [11, caller()],
      [18, caller()],
      [9, caller({}, { tier: 'gold' } as never)],
      [9, caller({}, { isModerator: true })],
      [9, caller({ features: { isGreen: true } as RemixAppCaller['features'] })],
    ];
    for (const [imageId, who] of variants) {
      const before = h.whatIfFromGraph.mock.calls.length;
      await quoteRemixApps({ imageId, caller: who });
      expect(h.whatIfFromGraph.mock.calls.length - before).toBe(perOpen);
    }
  });
});
