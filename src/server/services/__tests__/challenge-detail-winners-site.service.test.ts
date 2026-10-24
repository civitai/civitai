import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as UserService from '~/server/services/user.service';

// The detail page's winners and cover go through the same site gating as the challenge list.

const { mockGetChallengeById } = vi.hoisted(() => ({ mockGetChallengeById: vi.fn() }));

vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  getChallengeById: mockGetChallengeById,
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getChallengeConfig: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
  getCosmeticsForUsers: vi.fn(async () => ({})),
}));

const { getChallengeDetail, getCompletedChallengesWithWinners } = await import(
  '~/server/services/challenge.service'
);

const WINNER_URL = 'winner-image-url';
const VIEWER = 333;

const completedSystemChallenge = {
  id: 500,
  title: 'Done',
  status: 'Completed',
  collectionId: null,
  startsAt: new Date('2026-01-10T18:00:00Z'),
  endsAt: new Date('2026-01-12T18:00:00Z'),
  visibleAt: new Date('2026-01-01T00:00:00Z'),
  description: null,
  theme: 'test',
  invitation: null,
  coverImageId: null,
  nsfwLevel: NsfwLevel.X,
  allowedNsfwLevel: NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X,
  modelVersionIds: [],
  judgeId: null,
  prizes: [],
  entryPrize: null,
  createdById: null,
  source: 'System',
  eventId: null,
  metadata: null,
  judgingCategories: null,
  buzzType: 'yellow',
  ingestion: 'Scanned',
};

const winnerRow = (imageNsfwLevel: number, image: Record<string, unknown> = {}) => ({
  id: 1,
  challengeId: 500,
  userId: 9,
  username: 'winner',
  imageId: 70,
  imageUrl: WINNER_URL,
  imageNsfwLevel,
  imageHash: 'winner-hash',
  imageIngestion: 'Scanned',
  imageBlockedFor: null,
  imageReviewed: true,
  ...image,
  place: 1,
  buzzAwarded: 0,
  pointsAwarded: 0,
  reason: null,
  collectionItemNote: null,
});

async function winnerUrl(imageNsfwLevel: number, viewerId: number | undefined, isGreen: boolean) {
  mockGetChallengeById.mockResolvedValue(completedSystemChallenge);
  dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
    strings.join('').includes('"ChallengeWinner"')
      ? [winnerRow(imageNsfwLevel)]
      : [{ id: -1, username: 'civitai', image: null, deletedAt: null }]) as never);
  const detail = await getChallengeDetail(500, viewerId, isGreen, false, true);
  expect(detail?.winners).toHaveLength(1);
  return detail!.winners[0].imageUrl;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getChallengeDetail — winner images', () => {
  it.each([
    ['signed out', undefined],
    ['signed in', VIEWER],
  ])('withholds an X winner image on the green site (%s)', async (_, viewerId) => {
    expect(await winnerUrl(NsfwLevel.X, viewerId, true)).toBeNull();
  });

  it('keeps an SFW winner image on the green site', async () => {
    expect(await winnerUrl(NsfwLevel.PG, undefined, true)).toBe(WINNER_URL);
  });

  it('keeps a PG-13 winner image for a signed-in viewer on the green site', async () => {
    expect(await winnerUrl(NsfwLevel.PG13, VIEWER, true)).toBe(WINNER_URL);
  });

  it('keeps an X winner image on the mature site', async () => {
    expect(await winnerUrl(NsfwLevel.X, VIEWER, false)).toBe(WINNER_URL);
  });
});

// A blocked or unscanned winner image is withheld on every site, signed in or out; the winner and
// their place stay.
const withheldImages: Array<[string, number, Record<string, unknown>]> = [
  ['a Blocked level on a scanned image', NsfwLevel.Blocked, {}],
  ['a Blocked ingestion', NsfwLevel.X, { imageIngestion: 'Blocked', imageReviewed: false }],
  [
    'a block reason left by a rescan',
    NsfwLevel.X,
    { imageIngestion: 'Rescan', imageBlockedFor: 'tos', imageReviewed: false },
  ],
  ['an image with no media', NsfwLevel.X, { imageIngestion: 'NotFound', imageReviewed: false }],
];

const winnerPaths: Record<
  string,
  (row: ReturnType<typeof winnerRow>) => Promise<Record<string, unknown>>
> = {
  'challenge detail': async (row) => {
    mockGetChallengeById.mockResolvedValue(completedSystemChallenge);
    dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('').includes('"ChallengeWinner"')
        ? [row]
        : [{ id: -1, username: 'civitai', image: null, deletedAt: null }]) as never);
    const detail = await getChallengeDetail(500, VIEWER, false, false, true);
    expect(detail?.winners).toHaveLength(1);
    return detail!.winners[0];
  },
  'previous winners': async (row) => {
    dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('').includes('"ChallengeWinner"')
        ? [row]
        : [
            {
              ...completedSystemChallenge,
              prizePool: 0,
              entryCount: BigInt(0),
              commentCount: BigInt(0),
              createdById: -1,
            },
          ]) as never);
    dbMock.dbRead.image.findMany.mockResolvedValue([] as never);
    const { items } = await getCompletedChallengesWithWinners({
      limit: 20,
      currentUserId: VIEWER,
      isGreen: false,
    } as Parameters<typeof getCompletedChallengesWithWinners>[0]);
    expect(items[0].winners).toHaveLength(1);
    return items[0].winners[0];
  },
};

describe.each(Object.keys(winnerPaths))('%s — withheld winner images', (path) => {
  it.each(withheldImages)('withholds the image for %s', async (_, nsfwLevel, image) => {
    const winner = await winnerPaths[path](winnerRow(nsfwLevel, image));
    expect(winner).toMatchObject({
      place: 1,
      userId: 9,
      username: 'winner',
      imageId: null,
      imageUrl: null,
      imageHash: null,
      imageNsfwLevel: null,
    });
  });

  it('keeps a scanned winner image', async () => {
    const winner = await winnerPaths[path](winnerRow(NsfwLevel.X));
    expect(winner).toMatchObject({
      imageId: 70,
      imageUrl: WINNER_URL,
      imageHash: 'winner-hash',
      imageNsfwLevel: NsfwLevel.X,
    });
  });
});

describe('getChallengeDetail — cover image', () => {
  async function cover(
    nsfwLevel: number,
    viewerId: number | undefined,
    isGreen: boolean,
    challenge: Record<string, unknown> = completedSystemChallenge,
    image: Record<string, unknown> = {}
  ) {
    mockGetChallengeById.mockResolvedValue({ ...challenge, coverImageId: 80 });
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      id: 80,
      url: 'cover-image-url',
      nsfwLevel,
      hash: 'cover-hash',
      width: 512,
      height: 512,
      type: 'image',
      ingestion: 'Scanned',
      blockedFor: null,
      ...image,
    } as never);
    const detail = await getChallengeDetail(500, viewerId, isGreen, false, true);
    expect(detail).not.toBeNull();
    return detail!.coverImage;
  }

  it.each([
    ['signed out', undefined],
    ['signed in', VIEWER],
  ])('withholds an X cover on the green site (%s)', async (_, viewerId) => {
    expect(await cover(NsfwLevel.X, viewerId, true)).toBeNull();
  });

  it('withholds a PG-13 cover on the green site from a signed-out viewer', async () => {
    expect(await cover(NsfwLevel.PG13, undefined, true)).toBeNull();
  });

  it('keeps an SFW cover on the green site', async () => {
    expect((await cover(NsfwLevel.PG, undefined, true))?.url).toBe('cover-image-url');
  });

  it('keeps a PG-13 cover for a signed-in viewer on the green site', async () => {
    expect((await cover(NsfwLevel.PG13, VIEWER, true))?.url).toBe('cover-image-url');
  });

  // Deliberate, as for winners: the green site never serves its creator a cover above its ceiling
  // either. The creator still sees it on the mature site and in the moderator edit view.
  it("withholds an X cover on the green site from the challenge's own creator", async () => {
    const ownChallenge = {
      ...completedSystemChallenge,
      source: 'User',
      buzzType: 'green',
      createdById: VIEWER,
    };
    expect(await cover(NsfwLevel.X, VIEWER, true, ownChallenge)).toBeNull();
  });

  it('keeps an X cover on the mature site', async () => {
    expect((await cover(NsfwLevel.X, VIEWER, false))?.url).toBe('cover-image-url');
  });

  it.each([
    ['a Blocked level', NsfwLevel.Blocked, {}],
    ['a block reason', NsfwLevel.X, { blockedFor: 'tos' }],
  ])('withholds a cover with %s on the mature site', async (_, nsfwLevel, image) => {
    expect(await cover(nsfwLevel, VIEWER, false, completedSystemChallenge, image)).toBeNull();
  });
});
