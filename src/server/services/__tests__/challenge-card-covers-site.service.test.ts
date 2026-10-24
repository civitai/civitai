import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import type * as UserService from '~/server/services/user.service';

// Challenge cards and events serve cover images under the same site rating ceiling as the detail
// page, for every list that returns them.

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getChallengeConfig: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
  getCosmeticsForUsers: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const none = { getCached: vi.fn(async () => []) };
  return {
    ...(await importOriginal<typeof UserPreferencesService>()),
    HiddenUsers: none,
    BlockedUsers: none,
    BlockedByUsers: none,
  };
});

const {
  getActiveEvents,
  getChallengeEventById,
  getCompletedChallengesWithWinners,
  getDailyChallenges,
  getInfiniteChallenges,
  getMyChallenges,
} = await import('~/server/services/challenge.service');

const VIEWER = 333;
const COVER_URL = 'cover-image-url';
const CHALLENGE_COVER = 80;
const EVENT_COVER = 81;

const cardRow = {
  id: 500,
  title: 'Challenge',
  theme: null,
  invitation: null,
  coverImageId: CHALLENGE_COVER,
  startsAt: new Date('2026-01-10T18:00:00Z'),
  endsAt: new Date('2026-01-12T18:00:00Z'),
  status: 'Active',
  source: 'User',
  buzzType: 'green',
  prizePool: 0,
  entryCount: BigInt(0),
  commentCount: BigInt(0),
  modelVersionIds: [],
  modelId: null,
  modelName: null,
  nsfwLevel: NsfwLevel.PG,
  allowedNsfwLevel: NsfwLevel.PG,
  collectionId: null,
  // The viewer's own challenge, which their feed lists whatever its cover.
  createdById: VIEWER,
  creatorUsername: 'creator',
  creatorImage: null,
  creatorDeletedAt: null,
  judgeId: null,
  judgeName: null,
  judgeBio: null,
  judgeUserId: null,
  judgeUsername: null,
  judgeImage: null,
  judgeDeletedAt: null,
  myPlace: null,
  myActivityAt: new Date('2026-01-11T00:00:00Z'),
  isCreator: true,
};

const event = {
  id: 7,
  title: 'Event',
  description: null,
  titleColor: null,
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: new Date('2030-01-01T00:00:00Z'),
  coverImageId: EVENT_COVER,
  active: true,
  _count: { challenges: 1 },
};

function images(nsfwLevel: number, image: Record<string, unknown> = {}) {
  dbMock.dbRead.image.findMany.mockImplementation((async ({ where }: any) =>
    (where.id.in as number[]).map((id) => ({
      id,
      url: COVER_URL,
      nsfwLevel,
      hash: null,
      width: 512,
      height: 512,
      type: 'image',
      ingestion: 'Scanned',
      blockedFor: null,
      ...image,
    }))) as never);
}

type Site = { isGreen: boolean; viewerId?: number };

// The event paths also run the feed's visibility SQL (tested against Postgres in
// challenge-event-visibility.sql.behavior.test.ts); here every challenge passes it.
function eventQueries() {
  dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
    const sql = strings.join('');
    if (sql.includes('COUNT(*) AS count FROM "Challenge" c')) return [{ count: BigInt(1) }];
    if (sql.includes('FROM "Challenge" c')) return [{ id: cardRow.id }];
    return [];
  }) as never);
}

// Each list, as served to `site`, reduced to the one cover it returns.
const paths: Record<string, (site: Site) => Promise<{ url: string } | null | undefined>> = {
  'daily challenges': async (site) => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([cardRow] as never);
    return (await getDailyChallenges(site))[0].coverImage;
  },
  'challenge feed': async (site) => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([cardRow] as never);
    const { items } = await getInfiniteChallenges({
      limit: 20,
      includeEnded: false,
      excludeEventChallenges: false,
      canAccessUserChallenges: true,
      currentUserId: site.viewerId,
      isGreen: site.isGreen,
    } as Parameters<typeof getInfiniteChallenges>[0]);
    return items[0].coverImage;
  },
  'my challenges': async (site) => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([cardRow] as never);
    const items = await getMyChallenges({
      userId: site.viewerId!,
      limit: 20,
      isGreen: site.isGreen,
    } as Parameters<typeof getMyChallenges>[0]);
    return items[0].coverImage;
  },
  'previous winners': async (site) => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ ...cardRow, status: 'Completed' }] as never);
    const { items } = await getCompletedChallengesWithWinners({
      limit: 20,
      currentUserId: site.viewerId,
      isGreen: site.isGreen,
    } as Parameters<typeof getCompletedChallengesWithWinners>[0]);
    return items[0].coverImage;
  },
  'event banner': async (site) => {
    dbMock.dbRead.challengeEvent.findMany.mockResolvedValue([
      { ...event, challenges: [] },
    ] as never);
    eventQueries();
    return (await getActiveEvents(site, true))[0].coverImage;
  },
  'event challenge cover': async (site) => {
    dbMock.dbRead.challengeEvent.findMany.mockResolvedValue([
      { ...event, coverImageId: null, challenges: [{ ...cardRow, judgeId: null }] },
    ] as never);
    dbMock.dbRead.user.findMany.mockResolvedValue([] as never);
    eventQueries();
    return (await getActiveEvents(site, true))[0].challenges[0].coverImage;
  },
  'event by id': async (site) => {
    dbMock.dbRead.challengeEvent.findUnique.mockResolvedValue(event as never);
    eventQueries();
    return (await getChallengeEventById(event.id, site, true)).coverImage;
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// Signed-in only: the procedure requires a user.
const signedInOnly = new Set(['my challenges']);

describe.each(Object.keys(paths))('%s', (path) => {
  const cover = async (nsfwLevel: number, site: Site) => {
    images(nsfwLevel);
    return paths[path](site);
  };
  const signedOut = signedInOnly.has(path) ? it.skip : it;

  it('withholds an X cover on the green site (signed in)', async () => {
    expect(await cover(NsfwLevel.X, { isGreen: true, viewerId: VIEWER })).toBeNull();
  });

  signedOut('withholds an X cover on the green site (signed out)', async () => {
    expect(await cover(NsfwLevel.X, { isGreen: true })).toBeNull();
  });

  signedOut('withholds a PG-13 cover on the green site from a signed-out viewer', async () => {
    expect(await cover(NsfwLevel.PG13, { isGreen: true })).toBeNull();
  });

  it('keeps an SFW cover on the green site', async () => {
    expect((await cover(NsfwLevel.PG, { isGreen: true, viewerId: VIEWER }))?.url).toBe(COVER_URL);
  });

  it('keeps a PG-13 cover for a signed-in viewer on the green site', async () => {
    expect((await cover(NsfwLevel.PG13, { isGreen: true, viewerId: VIEWER }))?.url).toBe(COVER_URL);
  });

  it('keeps an X cover on the mature site', async () => {
    expect((await cover(NsfwLevel.X, { isGreen: false, viewerId: VIEWER }))?.url).toBe(COVER_URL);
  });

  it.each([
    ['a Blocked level', NsfwLevel.Blocked, {}],
    ['a block reason', NsfwLevel.X, { blockedFor: 'tos' }],
  ])('withholds a cover with %s on the mature site', async (_, nsfwLevel, image) => {
    images(nsfwLevel, image);
    expect(await paths[path]({ isGreen: false, viewerId: VIEWER })).toBeNull();
  });
});
