import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import * as c from '~/shared/constants/birthday2026.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('~/server/events/load-events', () => ({ loadEvents: () => load() }));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { getUserCreator, equipCosmetic } = await import('~/server/services/user.service');
const { getLeaderboardHandler } = await import('~/server/controllers/user.controller');
const { getUserWithProfile } = await import('~/server/services/user-profile.service');
const { modelWithDetailsSelect } = await import('~/server/selectors/model.selector');

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

  it("a model's owner carries what the owner wears", () => {
    const owner = modelWithDetailsSelect.user.select;
    expect(cosmeticsFor(owner).map((x) => x.cosmetic.id)).toEqual([1]);
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

  it('shows them to a tester, a moderator and the owner', async () => {
    expect(await profileHats({ sessionUserId: TESTER })).toHaveLength(2);
    expect(await profileHats({ sessionUserId: 99, isModerator: true })).toHaveLength(2);
    expect(await profileHats({ sessionUserId: OWNER })).toHaveLength(2);
  });

  it('shows them to everyone once the flag is public and the event has started', async () => {
    testerFlag.reset({ public: true });
    vi.setSystemTime(c.BIRTHDAY_2026_STARTS_AT);
    expect(await profileHats({})).toHaveLength(2);
    expect(await profileHats({ sessionUserId: 99 })).toHaveLength(2);
  });
});
