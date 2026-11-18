import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RemixGalleryService from '~/server/services/remix-gallery.service';
import type * as StickerBookService from '~/server/services/sticker-book.service';
import type * as HomeBlockService from '~/server/services/home-block.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The routers that read the image feeds hand them the views the request's credential allows,
 * through `credentialViews(ctx)`, not views of their own. These procedures take the full scope,
 * so the narrowed credential that reaches them is an app's token: full scope, issued to an OAuth
 * client, never a full user credential. A session is the control.
 */

const { getRemixGallery, getStickerBook, getStickerBookSection, homeBlocks } = vi.hoisted(() => ({
  homeBlocks: {
    getHomeBlocks: vi.fn(async (_input: unknown) => [
      { id: 1, type: 'Feed', userId: 5, metadata: {} },
    ]),
    getHomeBlockData: vi.fn(async (_input: unknown) => null),
  },
  getRemixGallery: vi.fn(async (_input: unknown) => ({ items: [], nextCursor: undefined })),
  getStickerBook: vi.fn(async (_input: unknown) => ({})),
  getStickerBookSection: vi.fn(async (_input: unknown) => ({ items: [] })),
}));
vi.mock('~/server/services/remix-gallery.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixGalleryService>()),
  getRemixGallery,
}));
vi.mock('~/server/services/sticker-book.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerBookService>()),
  getStickerBook,
  getStickerBookSection,
}));

vi.mock('~/server/services/home-block.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockService>()),
  ...homeBlocks,
}));

const { placementRouter } = await import('~/server/routers/placement.router');
const { homeBlockRouter } = await import('~/server/routers/home-block.router');
const { stickerBookRouter } = await import('~/server/routers/sticker-book.router');

const moderator = { id: 5, isModerator: true, muted: false, bannedAt: null, onboarding: 0x1f };
const appToken = { subject: { type: 'oauth', id: 'app' }, tokenScope: TokenScope.Full };

const ctx = (credential: object) =>
  ({
    user: moderator,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    ...credential,
    req: { headers: {}, cookies: {} },
    res: { setHeader: () => undefined },
    cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false },
    track: {},
    features: { isGreen: false, remixGallery: true, stickerBook: true, canViewNsfw: true },
  } as never);

beforeEach(() => vi.clearAllMocks());

describe.each([
  ['an app token', appToken, false],
  ['a session (control)', {}, true],
])("a moderator's request on %s", (_, credential, views) => {
  const expected = expect.objectContaining({ asModerator: views, asOwner: views });

  it(`reads the remix gallery with moderator and owner views: ${views}`, async () => {
    await placementRouter.createCaller(ctx(credential)).getRemixGallery({ imageId: 1 });
    expect(getRemixGallery).toHaveBeenCalledWith(expected);
  });

  it(`reads the sticker book and its section with moderator and owner views: ${views}`, async () => {
    const caller = stickerBookRouter.createCaller(ctx(credential));
    await caller.get({ username: 'creator', browsingLevel: 1 });
    await caller.getSection({ username: 'creator', side: 'owner', browsingLevel: 1 });
    const both = expect.objectContaining({ isModerator: views, asOwner: views });
    expect(getStickerBook).toHaveBeenCalledWith(both);
    expect(getStickerBookSection).toHaveBeenCalledWith(both);
  });

  it(`reads the home-block editor's blocks with moderator and owner views: ${views}`, async () => {
    await homeBlockRouter.createCaller(ctx(credential)).getHomeBlocks({ withCoreData: true });
    expect(homeBlocks.getHomeBlockData).toHaveBeenCalledWith(expected);
  });
});
