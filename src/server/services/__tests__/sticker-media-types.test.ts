import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementService from '~/server/services/placement.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The account's "images / videos" sticker setting, through the real resolver and
 * the real mutations that read it.
 *
 * `sticker-placement.service.test.ts` stubs the resolver at its boundary, which is
 * right for what it tests and blind to this: whether a video is refused depends on
 * the resolver and on both creation routes agreeing, so nothing in that file can
 * go red when the setting stops being applied. Here only the I/O edges are fakes.
 *
 * Every route is run against the same table. Reaching `assertCanPlace` is the
 * positive control for "accepted": it is the first thing both routes do after the
 * space has said yes, and a refusal is the one outcome that never gets there.
 */

vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: async () => ({
    min: 0,
    max: 500,
    freeSlotCap: 4,
    score: 0,
    tier: 'free' as const,
  }),
}));

const REACHED = new Error('reached assertCanPlace');
const assertCanPlace = vi.fn(async () => {
  throw REACHED;
});
vi.mock('~/server/services/placement-moderation.service', () => ({ assertCanPlace }));
vi.mock('~/server/services/placement-escrow.service', () => ({
  holdPlacementEscrow: vi.fn(),
  settlePlacement: vi.fn(),
  MAX_LEG_ATTEMPTS: 5,
}));
vi.mock('~/server/services/sticker.service', () => ({ spendStickerUsesFor: vi.fn() }));

const { resolvePlacementSpaceFor } = await import('~/server/services/placement-space.service');
const { createStickerPlacement } = await import('~/server/services/sticker-placement.service');
const { createFreePlacement } = await import('~/server/services/free-placement.service');

const OWNER = 41;
const PLACER = 52;
const IMAGE = 74;
const POST = 88;

const spaceFindMany = dbMock.dbWrite.placementSpace.findMany;
const imageFindUnique = dbMock.dbWrite.image.findUnique;

type Row = {
  entityType: 'user' | 'post' | 'image';
  mode: string;
  price: number | null;
  freeSlots: number | null;
  settings: Record<string, unknown>;
};

const account = (settings: Record<string, unknown>, mode = 'review'): Row => ({
  entityType: 'user',
  mode,
  price: 100,
  freeSlots: null,
  settings,
});
const own = (entityType: 'post' | 'image', mode = 'review'): Row => ({
  entityType,
  mode,
  price: null,
  freeSlots: null,
  settings: {},
});

const given = (imageType: 'image' | 'video' | 'audio', rows: Row[]) => {
  imageFindUnique.mockResolvedValue({
    id: IMAGE,
    userId: OWNER,
    postId: POST,
    type: imageType,
    user: { username: 'creator' },
  });
  spaceFindMany.mockResolvedValue(rows);
};

const data = { cosmeticId: 5, x: 0.25, y: 0.75, scale: 0.2, rotation: 15 };

/** Every way a sticker can be placed on an image, each reaching the resolver itself. */
const ROUTES: [string, () => Promise<unknown>][] = [
  [
    'paid, via createStickerPlacement',
    () =>
      createStickerPlacement({
        placerId: PLACER,
        imageId: IMAGE,
        data,
        spendType: 'yellow',
      }),
  ],
  [
    'free, via createStickerPlacement',
    () =>
      createStickerPlacement({
        placerId: PLACER,
        imageId: IMAGE,
        data,
        spendType: 'yellow',
        free: true,
      }),
  ],
  [
    'free, via createFreePlacement',
    () =>
      createFreePlacement({
        surface: 'sticker',
        targetType: 'image',
        targetId: IMAGE,
        placerId: PLACER,
        data: { cosmeticId: 5 },
      }),
  ],
];

/** `refused` is the space saying no; `reached` is the route getting past it. */
const outcome = async (route: () => Promise<unknown>) => {
  const error = await route().then(
    () => null,
    (e: unknown) => e
  );
  if (error === REACHED) return 'reached';
  if (error instanceof Error && /not accepting/.test(error.message)) return 'refused';
  throw new Error(`neither refused nor reached: ${String(error)}`, { cause: error });
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.placement.count.mockResolvedValue(0);
  // One row answers both raw reads the free route makes before the claim: the
  // sticker the placer owns, and their remaining uses of it.
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      id: 5,
      createdById: 63,
      owned: true,
      flags: 0,
      imageNsfwLevel: 1,
      spendable: 3,
      unlimited: false,
    },
  ]);
});

describe.each(ROUTES)('the account image/video setting, %s', (_name, route) => {
  it('refuses a video when only images are allowed', async () => {
    given('video', [account({ mediaTypes: ['image'] })]);

    expect(await outcome(route)).toBe('refused');
    expect(assertCanPlace).not.toHaveBeenCalled();
  });

  // The positive control for the one above: the same account, an image. Without
  // it a route that refused everything would pass the video case.
  it('still accepts an image when only images are allowed', async () => {
    given('image', [account({ mediaTypes: ['image'] })]);

    expect(await outcome(route)).toBe('reached');
  });

  it('refuses an image when only videos are allowed, and accepts the video', async () => {
    given('image', [account({ mediaTypes: ['video'] })]);
    expect(await outcome(route)).toBe('refused');

    given('video', [account({ mediaTypes: ['video'] })]);
    expect(await outcome(route)).toBe('reached');
  });

  // Every account that exists today, and every one that never touches the chips.
  it.each([
    ['no settings at all', {}],
    ['both types', { mediaTypes: ['image', 'video'] }],
    // A hand-edit can reach the column without the schema; an unreadable value
    // must leave the space open rather than silently closing it.
    ['an unreadable value', { mediaTypes: 'image' }],
    ['an empty list', { mediaTypes: [] }],
  ])('accepts a video with %s', async (_label, settings) => {
    given('video', [account(settings)]);

    expect(await outcome(route)).toBe('reached');
  });

  it('accepts a video the owner switched on in its own image settings', async () => {
    given('video', [account({ mediaTypes: ['image'] }), own('image')]);

    expect(await outcome(route)).toBe('reached');
  });

  it('accepts a video in a post the owner switched on', async () => {
    given('video', [account({ mediaTypes: ['image'] }), own('post')]);

    expect(await outcome(route)).toBe('reached');
  });

  // The specific choice wins in the other direction too: a video the owner closed
  // by hand stays closed under an account that allows videos.
  it('refuses a video the owner switched off in its own image settings', async () => {
    given('video', [account({ mediaTypes: ['image', 'video'] }), own('image', 'off')]);

    expect(await outcome(route)).toBe('refused');
  });

  it('refuses a video when the account itself is set to no stickers', async () => {
    given('video', [account({ mediaTypes: ['image', 'video'] }, 'off')]);

    expect(await outcome(route)).toBe('refused');
  });
});

describe('resolvePlacementSpaceFor', () => {
  const resolve = (surface: 'sticker' | 'remixGallery') =>
    resolvePlacementSpaceFor({ surface, targetType: 'image', targetId: IMAGE });

  it('treats audio like an image', async () => {
    given('audio', [account({ mediaTypes: ['image'] })]);
    expect((await resolve('sticker')).mode).toBe('review');

    given('audio', [account({ mediaTypes: ['video'] })]);
    expect((await resolve('sticker')).mode).toBe('off');
  });

  // The setting lives in the sticker row. A remix gallery reads its own row, and
  // must not be closed for videos because a sticker setting says so.
  it('leaves other surfaces alone', async () => {
    given('video', [account({ mediaTypes: ['image'] })]);

    expect((await resolve('remixGallery')).mode).toBe('review');
    expect((await resolve('sticker')).mode).toBe('off');
  });

  it('keeps the account price and settings when the media type is closed', async () => {
    given('video', [account({ mediaTypes: ['image'], maxScale: 0.1 })]);

    const space = await resolve('sticker');

    expect(space.mode).toBe('off');
    expect(space.setPrice).toBe(100);
    expect(space.settings).toMatchObject({ maxScale: 0.1, mediaTypes: ['image'] });
  });
});
