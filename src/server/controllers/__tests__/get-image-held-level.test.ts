import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import type * as ImageService from '~/server/services/image.service';
import type * as ModelService from '~/server/services/model.service';
import type * as UserService from '~/server/services/user.service';
import '~/__tests__/mocks/db.mock';

const { image, heldLevels } = vi.hoisted(() => ({
  image: vi.fn(),
  heldLevels: vi.fn(),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImage: image,
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getHeldLevelsByPost: heldLevels,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: async () => false,
}));

const { getImageHandler } = await import('~/server/controllers/image.controller');

type HandlerCtx = Parameters<typeof getImageHandler>[0]['ctx'];
const UPLOADER = 7;
const MODEL_OWNER = 50;
const HELD_POST = 30;

function urlFor(
  nsfwLevel: number,
  {
    user,
    subject,
    postId = HELD_POST,
  }: {
    user?: { id: number; isModerator?: boolean };
    subject?: unknown;
    postId?: number | null;
  } = {}
) {
  image.mockResolvedValueOnce({
    id: 1,
    postId,
    url: 'media-key',
    nsfwLevel,
    metadata: null,
    user: { id: UPLOADER },
  });
  const ctx = {
    user,
    subject,
    features: { canViewNsfw: true },
    req: { headers: {} },
    cache: null,
  } as unknown as HandlerCtx;
  return getImageHandler({ input: { id: 1 }, ctx }).then((result) => result.url);
}

beforeEach(() => {
  image.mockReset();
  heldLevels.mockReset();
  heldLevels.mockResolvedValue(
    new Map([[HELD_POST, { level: NsfwLevel.PG | NsfwLevel.PG13, ownerId: MODEL_OWNER }]])
  );
});

describe("getImageHandler on a minor or SFW-only model's post", () => {
  it('serves no media above the held level to another user or a signed-out viewer', async () => {
    expect(await urlFor(NsfwLevel.R, { user: { id: 99 } })).toBeNull();
    expect(await urlFor(NsfwLevel.R)).toBeNull();
  });

  it("holds the image's uploader too: only the model's owner is exempt", async () => {
    expect(await urlFor(NsfwLevel.R, { user: { id: UPLOADER } })).toBeNull();
  });

  it('serves no media for an image not yet rated, until it is rated within the level', async () => {
    expect(await urlFor(0, { user: { id: 99 } })).toBeNull();
  });

  it("holds a signed-out viewer when the model's owner is not known", async () => {
    heldLevels.mockResolvedValue(new Map([[HELD_POST, { level: NsfwLevel.PG }]]));
    expect(await urlFor(NsfwLevel.R)).toBeNull();
  });

  it('serves the image without media when the hold cannot be looked up', async () => {
    heldLevels.mockRejectedValue(new Error('lookup failed'));
    expect(await urlFor(NsfwLevel.PG13, { user: { id: 99 } })).toBeNull();
  });

  it('serves media within the held level', async () => {
    expect(await urlFor(NsfwLevel.PG13, { user: { id: 99 } })).toBe('media-key');
  });

  it("serves the model's owner the image whole", async () => {
    expect(await urlFor(NsfwLevel.R, { user: { id: MODEL_OWNER } })).toBe('media-key');
  });

  it("holds the model's owner coming through an app they authorised", async () => {
    expect(
      await urlFor(NsfwLevel.R, { user: { id: MODEL_OWNER }, subject: { type: 'oauth' } })
    ).toBeNull();
  });

  it('serves a moderator the image whole', async () => {
    expect(await urlFor(NsfwLevel.R, { user: { id: 5, isModerator: true } })).toBe('media-key');
  });

  it('holds a moderator who comes through an app they authorised', async () => {
    expect(
      await urlFor(NsfwLevel.R, { user: { id: 5, isModerator: true }, subject: { type: 'oauth' } })
    ).toBeNull();
  });

  it('leaves an image on a post of no held model, or on no post, as it was', async () => {
    heldLevels.mockResolvedValue(new Map());
    expect(await urlFor(NsfwLevel.R, { user: { id: 99 } })).toBe('media-key');

    heldLevels.mockClear();
    expect(await urlFor(NsfwLevel.R, { user: { id: 99 }, postId: null })).toBe('media-key');
    expect(heldLevels).not.toHaveBeenCalled();
  });
});

describe('getImageHandler, the image page', () => {
  it("asks for the owner's view of a held image as the session user, whatever the input names", async () => {
    image.mockResolvedValueOnce({
      id: 1,
      postId: null,
      url: 'media-key',
      nsfwLevel: 1,
      metadata: null,
      user: { id: UPLOADER },
    });
    const ctx = {
      user: { id: UPLOADER },
      features: { canViewNsfw: true },
      req: { headers: {} },
      cache: null,
    } as unknown as HandlerCtx;
    await getImageHandler({ input: { id: 1, userId: 99 } as never, ctx });
    expect(image).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, userId: UPLOADER, ownerSeesHeld: true })
    );
  });

  it("does not ask for the owner's view on an app token", async () => {
    image.mockResolvedValueOnce({
      id: 1,
      postId: null,
      url: 'media-key',
      nsfwLevel: 1,
      metadata: null,
      user: { id: UPLOADER },
    });
    const ctx = {
      user: { id: UPLOADER },
      subject: { type: 'oauth' },
      features: { canViewNsfw: true },
      req: { headers: {} },
      cache: null,
    } as unknown as HandlerCtx;
    await getImageHandler({ input: { id: 1 }, ctx });
    expect(image).toHaveBeenCalledWith(expect.objectContaining({ ownerSeesHeld: false }));
  });
});

describe('getImageHandler on a blocked image', () => {
  const MEDIA = 'blocked-media-key';
  const PREVIEW = 'blocked-blur-hash';
  const VIDEO = 'blocked-video-id';
  function read(
    row: { ingestion: string; blockedFor: string | null; nsfwLevel?: number },
    user: { id: number; isModerator?: boolean } = { id: UPLOADER }
  ) {
    heldLevels.mockResolvedValue(new Map());
    image.mockResolvedValueOnce({
      id: 1,
      postId: null,
      url: MEDIA,
      hash: PREVIEW,
      nsfwLevel: NsfwLevel.PG,
      metadata: { width: 10, youtubeVideoId: VIDEO, vimeoVideoId: VIDEO },
      cosmetic: { data: { url: 'frame' } },
      ...row,
      user: { id: UPLOADER },
    });
    const ctx = {
      user,
      features: { canViewNsfw: true },
      req: { headers: {} },
      cache: null,
    } as unknown as HandlerCtx;
    return getImageHandler({ input: { id: 1 }, ctx });
  }
  /** Every string anywhere in the response, so a media field at any depth is caught. */
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
      ? Object.values(value).flatMap(strings)
      : [];

  it.each([
    ['a moderator block', { ingestion: 'Blocked', blockedFor: BlockedReason.Moderated }],
    ['a CSAM block', { ingestion: 'Blocked', blockedFor: BlockedReason.CSAM }],
    ['a ToS block', { ingestion: 'Blocked', blockedFor: BlockedReason.TOS }],
    ['a block with no reason', { ingestion: 'Blocked', blockedFor: null }],
    ['a reason no code writes', { ingestion: 'Scanned', blockedFor: 'zzz' }],
  ])('serves its owner the block notice and no media at any depth: %s', async (_, row) => {
    const result = await read(row);
    expect(result).toMatchObject({ id: 1, blockedFor: row.blockedFor, ingestion: row.ingestion });
    expect(result.url).toBeNull();
    const served = strings(result);
    for (const media of [MEDIA, PREVIEW, VIDEO, 'frame']) expect(served).not.toContain(media);
  });

  it('serves its owner the media of an image held only for its metadata', async () => {
    const result = await read({ ingestion: 'Blocked', blockedFor: BlockedReason.AiNotVerified });
    expect(result.url).toBe(MEDIA);
  });

  it('serves its owner the media of an image rated Blocked with no block', async () => {
    const result = await read({
      ingestion: 'Scanned',
      blockedFor: null,
      nsfwLevel: NsfwLevel.Blocked,
    });
    expect(result.url).toBe(MEDIA);
  });

  it('serves a moderator the media of a blocked image', async () => {
    const result = await read(
      { ingestion: 'Blocked', blockedFor: BlockedReason.Moderated },
      { id: 5, isModerator: true }
    );
    expect(result.url).toBe(MEDIA);
  });
});
