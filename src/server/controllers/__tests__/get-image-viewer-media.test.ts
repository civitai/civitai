import { describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as ImageService from '~/server/services/image.service';
import type * as UserService from '~/server/services/user.service';
import type * as MediaVisibility from '~/server/utils/image-media-visibility';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';

/**
 * `image.get` is public and its result is dehydrated into `/images/[id]`, so the route itself has
 * to hold back media the viewer's gate would not show. The service stays unfiltered for its
 * server-side callers.
 */

const { image, blocked, manages } = vi.hoisted(() => ({
  image: vi.fn(),
  blocked: vi.fn(async () => false),
  manages: vi.fn<
    (args: { imageId: number; postId: number | null; userId: number }) => Promise<boolean>
  >(async () => false),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImage: image,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: blocked,
}));
vi.mock('~/server/utils/image-media-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaVisibility>()),
  managesImageCollection: manages,
}));

const { getImageHandler } = await import('~/server/controllers/image.controller');

type HandlerCtx = Parameters<typeof getImageHandler>[0]['ctx'];
const OWNER_ID = 7;

const POST_ID = 30;
const rated = (nsfwLevel: number, postId: number | null = POST_ID) => ({
  id: 1,
  postId,
  url: 'media-key',
  nsfwLevel,
  metadata: null,
  user: { id: OWNER_ID },
});

function ctxFor({
  user,
  canViewNsfw,
  bot,
}: {
  user?: { id: number; isModerator?: boolean };
  canViewNsfw: boolean;
  bot?: 'googlebot';
}) {
  // `cache: null` is what the SSR helpers pass (getServerProxySSGHelpers).
  return {
    user,
    features: { canViewNsfw },
    req: { headers: bot ? { [VERIFIED_BOT_HEADER]: bot } : {} },
    cache: null,
  } as unknown as HandlerCtx;
}

async function urlFor(ctx: HandlerCtx, nsfwLevel: number, postId?: number | null) {
  image.mockResolvedValueOnce(rated(nsfwLevel, postId));
  return (await getImageHandler({ input: { id: 1 }, ctx })).url;
}

describe('getImageHandler', () => {
  it.each([
    ['SFW', false],
    ['mature', true],
  ])('sends a signed-out viewer on the %s domain no media above PG', async (_, canViewNsfw) => {
    expect(await urlFor(ctxFor({ canViewNsfw }), NsfwLevel.R)).toBeNull();
    expect(await urlFor(ctxFor({ canViewNsfw }), NsfwLevel.PG)).toBe('media-key');
  });

  it('judges a signed-in viewer by their own session', async () => {
    const owner = ctxFor({ canViewNsfw: false, user: { id: OWNER_ID } });
    expect(await urlFor(owner, NsfwLevel.R)).toBe('media-key');

    const someoneElse = ctxFor({ canViewNsfw: false, user: { id: 99 } });
    expect(await urlFor(someoneElse, NsfwLevel.R)).toBeNull();
    expect(await urlFor(someoneElse, NsfwLevel.PG13)).toBe('media-key');
  });

  it("gives a manager of the post's collection the media they judge", async () => {
    const judge = ctxFor({ canViewNsfw: false, user: { id: 42 } });
    manages.mockImplementation(async ({ postId, userId }) => postId === POST_ID && userId === 42);
    try {
      expect(await urlFor(judge, NsfwLevel.R)).toBe('media-key');
      expect(await urlFor(judge, 0)).toBe('media-key');
      expect(
        await urlFor(ctxFor({ canViewNsfw: false, user: { id: 43 } }), NsfwLevel.R)
      ).toBeNull();
    } finally {
      manages.mockImplementation(async () => false);
    }
  });

  // The collection lookup is a DB query: only for a signed-in viewer the media would be withheld from.
  it('looks up collection management only when it could change the answer', async () => {
    manages.mockClear();
    await urlFor(ctxFor({ canViewNsfw: false, user: { id: OWNER_ID } }), NsfwLevel.R);
    await urlFor(ctxFor({ canViewNsfw: false, user: { id: 5, isModerator: true } }), NsfwLevel.R);
    await urlFor(ctxFor({ canViewNsfw: false, user: { id: 99 } }), NsfwLevel.PG13);
    await urlFor(ctxFor({ canViewNsfw: false }), NsfwLevel.R);
    expect(manages).not.toHaveBeenCalled();

    // A contest can hold an image directly, without a post.
    await urlFor(ctxFor({ canViewNsfw: false, user: { id: 99 } }), NsfwLevel.R);
    await urlFor(ctxFor({ canViewNsfw: false, user: { id: 99 } }), NsfwLevel.R, null);
    expect(manages.mock.calls).toEqual([
      [{ imageId: 1, postId: POST_ID, userId: 99 }],
      [{ imageId: 1, postId: null, userId: 99 }],
    ]);
  });

  it('serves a verified crawler on the mature domain during SSR, where there is no cache', async () => {
    const crawler = ctxFor({ canViewNsfw: true, bot: 'googlebot' });
    expect(await urlFor(crawler, NsfwLevel.R)).toBe('media-key');
  });
});
