import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import * as c from '~/shared/constants/birthday2026.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('~/server/events/load-events', () => ({ loadEvents: () => load() }));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { getUserCreator, equipCosmetic, getCosmeticsAndProfilePicturesForUsers } = await import(
  '~/server/services/user.service'
);
const { getLeaderboardHandler } = await import('~/server/controllers/user.controller');
const { getUserWithProfile } = await import('~/server/services/user-profile.service');
const { getUserProfileHandler } = await import('~/server/controllers/user-profile.controller');

/**
 * Event hats are content decorations: a user holds them and places them on images, models and
 * articles. Before launch only viewers the event's flag is on for may see them. The user-level
 * reads below (creator card, leaderboard, model owner) are cached for every viewer, so they must
 * not carry hats at all; the profile lists everything a user holds, so it filters hats per viewer.
 */
const PREVIEW = new Date(c.BIRTHDAY_2026_PREVIEW_FROM.getTime() + 24 * 60 * 60 * 1000);
const event = {
  name: c.BIRTHDAY_2026_EVENT,
  startDate: c.BIRTHDAY_2026_STARTS_AT,
  endDate: c.BIRTHDAY_2026_ENDS_AT,
  featureFlag: 'birthday2026' as const,
  previewFrom: c.BIRTHDAY_2026_PREVIEW_FROM,
};

const OWNER = 7;
const TESTER = 8;
const hatData = { type: 'hat', event: c.BIRTHDAY_2026_EVENT, url: 'hat.png', team: 'Blue' };
const rows = [
  {
    // Worn by the user.
    equippedAt: new Date(),
    equippedToId: null,
    data: null,
    cosmetic: { id: 1, name: 'Badge', type: 'Badge', source: 'Event', data: { url: 'b.png' } },
  },
  {
    // Placed on one of the user's images.
    equippedAt: new Date(),
    equippedToId: 100,
    data: { placedAt: '2026-10-10T00:00:00.000Z' },
    cosmetic: {
      id: 2,
      name: 'Party Hat',
      type: 'ContentDecoration',
      source: 'Event',
      data: hatData,
    },
  },
  {
    // Held, not placed.
    equippedAt: null,
    equippedToId: null,
    data: null,
    cosmetic: {
      id: 3,
      name: 'Party Hat',
      type: 'ContentDecoration',
      source: 'Event',
      data: hatData,
    },
  },
];

type Row = (typeof rows)[number];
type Where = Record<string, unknown>;

/** Applies a relation `where` the way Postgres would, for the two shapes these reads use. */
function matches(row: Row, where: Where | undefined) {
  return Object.entries(where ?? {}).every(([key, condition]) => {
    const value = row[key as keyof Row];
    if (condition === null) return value === null;
    if (
      condition &&
      typeof condition === 'object' &&
      'not' in condition &&
      (condition as { not: unknown }).not === null
    )
      return value !== null;
    throw new Error(`fake cannot evaluate ${key}: ${JSON.stringify(condition)}`);
  });
}

const cosmeticsFor = (select: { cosmetics?: { where?: Where } }) =>
  rows.filter((row) => matches(row, select.cosmetics?.where));

const hatsIn = (cosmetics: { cosmetic: { data: unknown } }[]) =>
  cosmetics.filter((x) => (x.cosmetic.data as { event?: string }).event === c.BIRTHDAY_2026_EVENT);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PREVIEW);
  testerFlag.reset({ testers: [OWNER, TESTER] });
  load.mockResolvedValue([event]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('user-level cosmetic reads carry no event hats', () => {
  it('the creator card returns what the user wears, not what they placed on content', async () => {
    dbMock.dbRead.user.findFirst.mockImplementation((async (args: {
      select: { cosmetics: { where?: Where } };
    }) => ({ id: OWNER, settings: null, cosmetics: cosmeticsFor(args.select) })) as never);
    dbMock.dbRead.model.count.mockResolvedValue(0 as never);

    const creator = await getUserCreator({ id: OWNER });
    expect(creator?.cosmetics.map((x) => x.cosmetic.id)).toEqual([1]);
  });

  it('the leaderboard returns what each user wears', async () => {
    dbMock.dbRead.user.findMany.mockImplementation((async (args: {
      select: { cosmetics: { where?: Where } };
    }) => [{ id: OWNER, cosmetics: cosmeticsFor(args.select) }]) as never);

    const [user] = (await getLeaderboardHandler({ input: {} as never })) as unknown as {
      cosmetics: Row[];
    }[];
    expect(user.cosmetics.map((x) => x.cosmetic.id)).toEqual([1]);
  });

  // Invariant guard, not regression coverage: the cache lookup always excluded placed hats. It
  // replaces the check on the model page's old nested select, which the owner no longer goes through.
  it("a model's owner, filled from the user cosmetic cache, carries what the owner wears", async () => {
    installUserCosmeticCacheFake({
      userCosmetics: rows.map((row) => ({ ...row, userId: OWNER, cosmeticId: row.cosmetic.id })),
      cosmetics: rows.map((row) => ({ ...row.cosmetic, flags: 0 })),
      profilePictures: [],
    });

    const owner = (await getCosmeticsAndProfilePicturesForUsers([OWNER]))(OWNER);
    expect(owner.cosmetics.map((x) => x.cosmetic.id)).toEqual([1]);
  });

  it('refuses to equip an event hat on the user', async () => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { obtainedAt: new Date(), cosmetic: { type: 'ContentDecoration', data: hatData } },
    ] as never);

    await expect(equipCosmetic({ userId: OWNER, cosmeticId: 3 })).rejects.toThrow(
      'Event decorations are placed on content'
    );
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('still equips any other cosmetic', async () => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { obtainedAt: new Date(), cosmetic: { type: 'Badge', data: { url: 'b.png' } } },
    ] as never);

    await equipCosmetic({ userId: OWNER, cosmeticId: 1 });
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('the profile shows event hats only to viewers the event is open to', () => {
  beforeEach(() => {
    dbMock.dbWrite.user.findUniqueOrThrow.mockResolvedValue({
      id: OWNER,
      meta: {},
      settings: null,
      profile: { userId: OWNER },
      cosmetics: rows,
    } as never);
    dbMock.dbRead.userStat.findFirst.mockResolvedValue(null as never);
  });

  const profileHats = async (viewer: { sessionUserId?: number; isModerator?: boolean }) =>
    hatsIn((await getUserWithProfile({ id: OWNER, ...viewer })).cosmetics);

  it('hides them before launch from a signed-out viewer and a viewer the flag is off for', async () => {
    expect(await profileHats({})).toHaveLength(0);
    expect(await profileHats({ sessionUserId: 99 })).toHaveLength(0);
  });

  it('keeps the rest of the holdings', async () => {
    const profile = await getUserWithProfile({ id: OWNER });
    expect(profile.cosmetics.map((x) => x.cosmetic.id)).toEqual([1]);
  });

  it('shows them to a tester and a moderator', async () => {
    expect(await profileHats({ sessionUserId: TESTER })).toHaveLength(2);
    expect(await profileHats({ sessionUserId: 99, isModerator: true })).toHaveLength(2);
  });

  it("gives the owner no exception: their own hats follow the flag like anyone else's", async () => {
    testerFlag.reset({ testers: [TESTER] });
    expect(await profileHats({ sessionUserId: OWNER })).toHaveLength(0);
    testerFlag.reset({ testers: [OWNER] });
    expect(await profileHats({ sessionUserId: OWNER })).toHaveLength(2);
  });

  it("treats a moderator's scoped token as the user alone", async () => {
    const hatsFor = async (bearer: object) =>
      hatsIn(
        (
          (await getUserProfileHandler({
            input: { username: 'owner' },
            ctx: { user: { id: 99, isModerator: true }, ...bearer },
          } as never)) as { cosmetics: Row[] }
        ).cosmetics
      );
    const key = { apiKeyId: 1, apiKeyType: 'User', subject: { type: 'apiKey', id: 1 } };
    expect(await hatsFor({})).toHaveLength(2);
    expect(await hatsFor({ ...key, tokenScope: TokenScope.Full })).toHaveLength(2);
    expect(await hatsFor({ ...key, tokenScope: TokenScope.UserRead })).toHaveLength(0);
  });

  it('hides them from everyone, testers and moderators too, once the launch is armed', async () => {
    testerFlag.reset({ public: true, testers: [TESTER] });
    expect(await profileHats({})).toHaveLength(0);
    expect(await profileHats({ sessionUserId: TESTER })).toHaveLength(0);
    expect(await profileHats({ sessionUserId: 99, isModerator: true })).toHaveLength(0);
  });

  it('hides them from everyone when the flag cannot be read', async () => {
    testerFlag.reset({ readable: false, testers: [TESTER] });
    expect(await profileHats({ sessionUserId: TESTER })).toHaveLength(0);
    expect(await profileHats({ sessionUserId: 99, isModerator: true })).toHaveLength(0);
  });

  it('after the start, the kill switch hides them from all but the flag audience', async () => {
    vi.setSystemTime(c.BIRTHDAY_2026_STARTS_AT);
    expect(await profileHats({})).toHaveLength(0);
    expect(await profileHats({ sessionUserId: 99 })).toHaveLength(0);
    expect(await profileHats({ sessionUserId: TESTER })).toHaveLength(2);
  });

  it('keeps showing them after the event ends', async () => {
    testerFlag.reset({ public: true });
    vi.setSystemTime(new Date(c.BIRTHDAY_2026_ENDS_AT.getTime() + 24 * 60 * 60 * 1000));
    expect(await profileHats({})).toHaveLength(2);
  });

  it('shows them to everyone once the flag is public and the event has started', async () => {
    testerFlag.reset({ public: true });
    vi.setSystemTime(c.BIRTHDAY_2026_STARTS_AT);
    expect(await profileHats({})).toHaveLength(2);
    expect(await profileHats({ sessionUserId: 99 })).toHaveLength(2);
  });
});

/**
 * The profile filters hats for the viewer, which is safe only while nothing caches its response
 * per URL: an edge or Redis cache would serve one tester's preview hats to everyone.
 */
describe('userProfile.get stays per-viewer', () => {
  it('has no cache middleware', () => {
    const router = readFileSync(
      join(process.cwd(), 'src/server/routers/user-profile.router.ts'),
      'utf8'
    );
    const start = router.indexOf('get: publicProcedure');
    expect(start, 'userProfile.get procedure not found').toBeGreaterThan(-1);
    const end = router.indexOf('.query(getUserProfileHandler)', start);
    expect(end).toBeGreaterThan(start);
    const route = router.slice(start, end);
    expect(route).not.toMatch(/edgeCacheIt|cacheIt/);
    expect(route).not.toMatch(/\.use\(/);
  });
});
