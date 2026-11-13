import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as ImageService from '~/server/services/image.service';
import type * as UserService from '~/server/services/user.service';
import type { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
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
    (args: { postId: number; imageOwnerId: number; userId: number }) => Promise<boolean>
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

const { getImageHandler } = await import('~/server/controllers/image.controller');

// `managesPostCollection` asks the database; answer from `manages`, by the values it binds.
beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockImplementation((async (sql: Prisma.Sql) => {
    const [postId, imageOwnerId, userId] = sql.values as number[];
    return [{ managed: await manages({ postId, imageOwnerId, userId }) }];
  }) as never);
});

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

  it('looks up collection management only when it could change the answer', async () => {
    manages.mockClear();
    await urlFor(ctxFor({ canViewNsfw: false, user: { id: OWNER_ID } }), NsfwLevel.R);
    await urlFor(ctxFor({ canViewNsfw: false, user: { id: 5, isModerator: true } }), NsfwLevel.R);
    await urlFor(ctxFor({ canViewNsfw: false, user: { id: 99 } }), NsfwLevel.PG13);
    await urlFor(ctxFor({ canViewNsfw: false }), NsfwLevel.R);
    // No post, no collection it was submitted to.
    expect(
      await urlFor(ctxFor({ canViewNsfw: false, user: { id: 99 } }), NsfwLevel.R, null)
    ).toBeNull();
    expect(manages).not.toHaveBeenCalled();

    await urlFor(ctxFor({ canViewNsfw: false, user: { id: 99 } }), NsfwLevel.R);
    expect(manages).toHaveBeenCalledExactlyOnceWith({
      postId: POST_ID,
      imageOwnerId: OWNER_ID,
      userId: 99,
    });
  });

  it('serves a verified crawler on the mature domain during SSR, where there is no cache', async () => {
    const crawler = ctxFor({ canViewNsfw: true, bot: 'googlebot' });
    expect(await urlFor(crawler, NsfwLevel.R)).toBe('media-key');
  });
});
