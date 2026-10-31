import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
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
  heldLevels.mockReset();
  heldLevels.mockResolvedValue(
    new Map([[HELD_POST, { level: NsfwLevel.PG | NsfwLevel.PG13, ownerId: MODEL_OWNER }]])
  );
});

describe("getImageHandler on a minor or SFW-only model's post", () => {
  it('serves no media above the held level to anyone else', async () => {
    expect(await urlFor(NsfwLevel.R, { user: { id: 99 } })).toBeNull();
    expect(await urlFor(NsfwLevel.R, { user: { id: UPLOADER } })).toBeNull();
    expect(await urlFor(NsfwLevel.R)).toBeNull();
    expect(heldLevels).toHaveBeenCalledWith([HELD_POST]);
  });

  it('serves media within the held level', async () => {
    expect(await urlFor(NsfwLevel.PG13, { user: { id: 99 } })).toBe('media-key');
  });

  it("serves the model's owner the image whole", async () => {
    expect(await urlFor(NsfwLevel.R, { user: { id: MODEL_OWNER } })).toBe('media-key');
  });

  it('serves a moderator the image whole, without looking up the hold', async () => {
    expect(await urlFor(NsfwLevel.R, { user: { id: 5, isModerator: true } })).toBe('media-key');
    expect(heldLevels).not.toHaveBeenCalled();
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
