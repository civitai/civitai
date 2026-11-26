import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserService from '~/server/services/user.service';
import type * as FileService from '~/server/services/file.service';

/**
 * article.getById body media: whoever is not the owner or a moderator gets no uuid of a body image
 * that is unscanned, blocked, awaiting review or a violation, nor of a video with no linked row; csam-held media is withheld from its
 * owner too. A servable image above the viewer's level still comes back, for the page to blur.
 */

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileService>()),
  getFilesByEntity: vi.fn(async () => []),
}));
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEventDecorationsForEntity: async () => ({}),
}));
vi.mock('~/server/utils/region-blocking', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRegion: () => ({ countryCode: 'XX' }),
  isRegionRestricted: () => false,
}));

const { articleRouter } = await import('../article.router');

const { PG, R } = NsfwLevel;
const OWNER_ID = 42;
const uuid = (n: number) =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(
    12
  )}`;
const SERVABLE = uuid(1);
const ABOVE_LEVEL = uuid(2);
const PENDING = uuid(3);
const BLOCKED = uuid(4);
const VIOLATION = uuid(5);
const CSAM_HELD = uuid(6);
const ALL = [SERVABLE, ABOVE_LEVEL, PENDING, BLOCKED, VIOLATION, CSAM_HELD];
/** In the body as a video, with no image row connected to the article. */
const UNLINKED = uuid(7);

const imageUrl = (id: string) => `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${id}/x.jpeg`;

function image(id: number, url: string, extra: Record<string, unknown> = {}) {
  return {
    image: {
      id,
      url,
      nsfwLevel: PG,
      ingestion: 'Scanned',
      needsReview: null,
      tosViolation: false,
      modelRestricted: false,
      userId: OWNER_ID,
      hash: null,
      width: 1,
      height: 1,
      ...extra,
    },
  };
}

const member = { id: 2, isModerator: false, tier: 'free', muted: false, bannedAt: null };
const moderator = { id: 1, isModerator: true, tier: 'free', muted: false, bannedAt: null };
const owner = { id: OWNER_ID, isModerator: false, tier: 'free', muted: false, bannedAt: null };

async function getById(user?: unknown) {
  dbMock.dbRead.article.findFirst.mockResolvedValue({
    id: 7,
    userId: OWNER_ID,
    nsfwLevel: PG,
    content:
      ALL.map((id) => `<p>${id.slice(0, 1)}</p><img src="${imageUrl(id)}">`).join('') +
      `<edge-media url="${UNLINKED}" type="video"></edge-media>` +
      `<edge-media url="legacy-key" type="video"></edge-media>`,
    tags: [],
    metadata: null,
    coverImage: null,
    bannerImage: null,
  } as never);
  const rows = [
    image(1, SERVABLE),
    image(2, ABOVE_LEVEL, { nsfwLevel: R }),
    image(3, PENDING, { ingestion: 'Pending' }),
    image(4, BLOCKED, { ingestion: 'Blocked' }),
    image(5, VIOLATION, { tosViolation: true }),
    image(6, CSAM_HELD, { needsReview: 'csam' }),
  ];
  // Only the fields the service selects come back, as from Prisma.
  dbMock.dbRead.imageConnection.findMany.mockImplementation((async (args: any) => {
    const fields = Object.keys(args.include.image.select);
    return rows.map(({ image }) => ({
      image: Object.fromEntries(fields.map((field) => [field, (image as any)[field]])),
    }));
  }) as never);
  const ctx = {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: null,
    features: {} as never,
    track: undefined,
  };
  const article = await articleRouter.createCaller(ctx as never).getById({ id: 7 });
  const sent = JSON.stringify({
    content: article.content,
    contentJson: article.contentJson,
    contentImages: article.contentImages,
  });
  return (id: string) => sent.includes(id);
}

describe('article.getById body media', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['a signed-out reader', undefined],
    ['a signed-in reader', member],
  ])('🔴 %s gets no uuid of unservable media', async (_, user) => {
    const sent = await getById(user);

    for (const id of [PENDING, BLOCKED, VIOLATION, CSAM_HELD, UNLINKED, 'legacy-key'])
      expect(sent(id)).toBe(false);
  });

  it.each([
    ['a signed-out reader', undefined],
    ['a signed-in reader', member],
  ])('%s still gets servable images, above-level ones included', async (_, user) => {
    const sent = await getById(user);

    expect(sent(SERVABLE)).toBe(true);
    expect(sent(ABOVE_LEVEL)).toBe(true);
  });

  it('🔴 the owner gets their own unscanned and violation media, but not blocked or csam-held', async () => {
    const sent = await getById(owner);

    for (const id of [SERVABLE, ABOVE_LEVEL, PENDING, VIOLATION, UNLINKED])
      expect(sent(id)).toBe(true);
    // A block refuses its owner the media (`ownerMediaAllowed`).
    expect(sent(BLOCKED)).toBe(false);
    expect(sent(CSAM_HELD)).toBe(false);
  });

  it('a moderator gets all of it', async () => {
    const sent = await getById(moderator);

    for (const id of [...ALL, UNLINKED, 'legacy-key']) expect(sent(id)).toBe(true);
  });
});
