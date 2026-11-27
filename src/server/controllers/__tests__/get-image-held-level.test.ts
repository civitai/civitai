import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import type * as ImageService from '~/server/services/image.service';
import type * as ModelService from '~/server/services/model.service';
import type * as UserService from '~/server/services/user.service';
import '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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

describe('getImageHandler on a blocked image, with ownerBlockedMedia', () => {
  const MEDIA = 'blocked-media-key';
  const PREVIEW = 'blocked-blur-hash';
  const VIDEO = 'blocked-video-id';
  function read(
    row: { blockedFor: string; ownerCsamMarked?: boolean | null },
    {
      user = { id: UPLOADER },
      flag = true,
      credential = {},
    }: {
      user?: { id: number; isModerator?: boolean };
      flag?: boolean;
      credential?: Record<string, unknown>;
    } = {}
  ) {
    heldLevels.mockResolvedValue(new Map());
    image.mockResolvedValueOnce({
      id: 1,
      postId: null,
      url: MEDIA,
      hash: PREVIEW,
      nsfwLevel: NsfwLevel.PG,
      ingestion: 'Blocked',
      metadata: { width: 10, youtubeVideoId: VIDEO, vimeoVideoId: VIDEO },
      cosmetic: { data: { url: 'frame' } },
      ...row,
      user: { id: UPLOADER },
    });
    const ctx = {
      user,
      features: { canViewNsfw: true, ownerBlockedMedia: flag },
      req: { headers: {} },
      cache: null,
      ...credential,
    } as unknown as HandlerCtx;
    return getImageHandler({ input: { id: 1 }, ctx });
  }
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
      ? Object.values(value).flatMap(strings)
      : [];
  const keys = (value: unknown): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
      : [];
  const notice = (result: Record<string, unknown>) => {
    expect(result.url).toBeNull();
    expect(result.hash).toBeNull();
    expect(result).not.toHaveProperty('ownerRetractedMedia');
    for (const media of [MEDIA, PREVIEW, VIDEO, 'frame'])
      expect(strings(result)).not.toContain(media);
  };

  it('asks image.get for the CSAM check only with the flag on', async () => {
    await read({ blockedFor: BlockedReason.Moderated, ownerCsamMarked: false });
    expect(image).toHaveBeenLastCalledWith(expect.objectContaining({ ownerReviewedBlocks: true }));
    await read({ blockedFor: BlockedReason.Moderated }, { flag: false });
    expect(image).toHaveBeenLastCalledWith(expect.objectContaining({ ownerReviewedBlocks: false }));
  });

  it.each([BlockedReason.Moderated, BlockedReason.TOS, 'moderated,tos'])(
    'sends the owner of a %s block with no CSAM mark to the owner route, with no url',
    async (blockedFor) => {
      const result = await read({ blockedFor, ownerCsamMarked: false });
      expect(result).toMatchObject({ url: null, hash: PREVIEW, ownerRetractedMedia: true });
      for (const media of [MEDIA, VIDEO]) expect(strings(result)).not.toContain(media);
      expect(keys(result)).not.toContain('ownerCsamMarked');
    }
  );

  it.each([
    ['a CSAM mark', { blockedFor: BlockedReason.Moderated, ownerCsamMarked: true }],
    ['an unread CSAM check', { blockedFor: BlockedReason.Moderated, ownerCsamMarked: null }],
    ['csam in the list', { blockedFor: 'moderated,csam', ownerCsamMarked: false }],
    ['an unknown reason', { blockedFor: 'zzz', ownerCsamMarked: false }],
    ['a moderated and unknown reason', { blockedFor: 'moderated,zzz', ownerCsamMarked: false }],
  ])('serves its owner only the notice for %s', async (_, row) => {
    const result = await read(row);
    notice(result);
    expect(keys(result)).not.toContain('ownerCsamMarked');
  });

  it('serves the owner only the notice with the flag off, as before', async () => {
    notice(
      await read({ blockedFor: BlockedReason.Moderated, ownerCsamMarked: false }, { flag: false })
    );
  });

  it('serves only the notice to a moderator acting as the owner, or to a scoped key', async () => {
    const row = { blockedFor: BlockedReason.Moderated, ownerCsamMarked: false };
    notice(await read(row, { credential: { impersonatedBy: 5 } }));
    notice(
      await read(row, {
        credential: {
          apiKeyId: 9,
          apiKeyType: 'User',
          subject: { type: 'apiKey', id: 9 },
          tokenScope: TokenScope.ModelsRead,
        },
      })
    );
  });

  it('never sends anyone but the owner to the owner route', async () => {
    notice(
      await read(
        { blockedFor: BlockedReason.Moderated, ownerCsamMarked: false },
        { user: { id: 99 } }
      )
    );
  });

  it('leaves a moderator their own image by url, not the owner route', async () => {
    const result = await read(
      { blockedFor: BlockedReason.Moderated, ownerCsamMarked: false },
      { user: { id: UPLOADER, isModerator: true } }
    );
    expect(result.url).toBe(MEDIA);
    expect(result).not.toHaveProperty('ownerRetractedMedia');
  });

  it('leaves a moderator the url, not the owner route', async () => {
    const result = await read(
      { blockedFor: BlockedReason.Moderated, ownerCsamMarked: false },
      { user: { id: 5, isModerator: true } }
    );
    expect(result.url).toBe(MEDIA);
    expect(result).not.toHaveProperty('ownerRetractedMedia');
  });
});
