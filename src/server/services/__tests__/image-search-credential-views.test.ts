import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * The public REST image search reads with the views the request's credential allows: a moderator's
 * or the owner's only on a session or a full-access key, never on a scoped key. Both the database
 * path and the feed-service path are checked.
 */

vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: vi.fn(() => ({ canViewNsfw: true, datapacketRead: false })),
  buildFliptContext: vi.fn(() => ({})),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  getFliptVariant: vi.fn(async () => 'off'),
}));
vi.mock('~/server/redis/caches', () => ({
  imageMetaCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: vi.fn(() => 'https://edge/x') }));

const feedSearch = vi.fn(async (_input?: unknown) => ({
  items: [] as unknown[],
  nextCursor: undefined as string | undefined,
}));
const legacySearch = vi.fn(async (_input?: unknown) => ({
  items: [] as unknown[],
  nextCursor: undefined as string | undefined,
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: (...args: unknown[]) => legacySearch(...(args as [unknown])),
  getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getImagesFromFeedServiceForRest: (...args: unknown[]) => feedSearch(...(args as [unknown])),
}));

import { runImageSearch } from '../image-search.service';

const moderator = { id: 5, isModerator: true };
const key = (tokenScope: bigint) => ({
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 9 },
  tokenScope,
});
const request = (context?: object) =>
  ({
    headers: { 'user-agent': 'probe/1.0' },
    socket: { remoteAddress: '203.0.113.7' },
    ...(context && { context }),
  } as unknown as NextApiRequest);

const search = (context: object | undefined, data: object) =>
  runImageSearch(
    { limit: 10, withMeta: false, withTags: false, data } as never,
    {
      browsingLevel: 1,
      user: moderator,
      req: request(context),
    } as never
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ['a scoped key', key(TokenScope.MediaRead), false],
  ['a full-access key (control)', key(TokenScope.Full), true],
  ['a session (control)', undefined, true],
])("a moderator's REST image search on %s", (_, context, elevated) => {
  it('hydrates from the database with the same views', async () => {
    await search(context, { ids: [1] });
    expect(legacySearch).toHaveBeenCalledWith(
      expect.objectContaining({ asModerator: elevated, asOwner: elevated })
    );
  });

  it('asks the feed and hydrates with the same views', async () => {
    await search(context, {});
    const [searchInput, hydrateInput] = feedSearch.mock.calls[0] as unknown as [
      { isModerator?: boolean },
      { asModerator?: boolean; asOwner?: boolean }
    ];
    expect(searchInput.isModerator).toBe(elevated);
    expect(hydrateInput).toMatchObject({ asModerator: elevated, asOwner: elevated });
  });
});
