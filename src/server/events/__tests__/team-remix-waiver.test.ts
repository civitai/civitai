import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EventAccess from '~/server/events/event-access';
import type { EventAccess as Access } from '~/server/events/event-access';

const EVENT = 'party';
const PLACER = 7;
const OWNER = 8;
const HOST = 900;

const def = {
  name: EVENT,
  startDate: new Date('2026-11-01T00:00:00Z'),
  endDate: new Date('2026-12-01T00:00:00Z'),
  join: { claimKey: 'claimed', design: 'basic' },
  scoring: { teamRemixWaiver: { perPlacerPerDay: 10 } },
};
const events = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => events.list }));

const access = vi.hoisted(() => ({ value: 'open' as Access }));
vi.mock('~/server/events/event-access', async (importOriginal) => ({
  ...(await importOriginal<typeof EventAccess>()),
  getEventAccess: async () => access.value,
}));

const { findTeamRemixWaiver } = await import('~/server/events/team-remix-waiver');

/**
 * The two reads, answered from fixtures by what they ask, not by call order. The hat read finds a
 * hat only for this host placed by its owner on their own image, so a query that bound the placer,
 * or dropped the owner condition, finds none.
 */
let hats: { entityId: number; userId: number; entityOwnerId: number }[];
let joins: { userId: number; team: string }[];
const answer = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?');
  if (text.includes('"EventCosmeticPlacement"')) {
    const [event, entityId, userId, entityOwnerId] = values;
    return hats.some(
      (h) =>
        event === EVENT &&
        h.entityId === entityId &&
        h.userId === userId &&
        h.entityOwnerId === entityOwnerId
    )
      ? [{ hatted: 1 }]
      : [];
  }
  if (text.includes('"UserCosmetic"')) {
    const [a, b, claimKey, event, design] = values;
    if (claimKey !== 'claimed' || event !== EVENT || design !== 'basic') return [];
    return joins.filter((j) => j.userId === a || j.userId === b);
  }
  throw new Error(`unexpected query: ${text}`);
};

const find = () => findTeamRemixWaiver({ placerId: PLACER, ownerId: OWNER, hostImageId: HOST });

beforeEach(() => {
  vi.clearAllMocks();
  events.list = [def];
  access.value = 'open';
  hats = [{ entityId: HOST, userId: OWNER, entityOwnerId: OWNER }];
  joins = [
    { userId: PLACER, team: 'Pink' },
    { userId: OWNER, team: 'Pink' },
  ];
  dbMock.dbWrite.$queryRaw.mockImplementation(answer as never);
});

describe('findTeamRemixWaiver', () => {
  it('waives for two members of the same team on a hatted image', async () => {
    await expect(find()).resolves.toEqual({ event: EVENT, team: 'Pink', perDay: 10 });
  });

  it('refuses teammates on different teams', async () => {
    joins = [
      { userId: PLACER, team: 'Blue' },
      { userId: OWNER, team: 'Pink' },
    ];
    await expect(find()).resolves.toBeNull();
  });

  it.each([
    ['the placer', OWNER],
    ['the owner', PLACER],
  ])('refuses when %s has not joined', async (_who, joinedId) => {
    // A team is computed for everyone; only a held join cosmetic is joining.
    joins = joins.filter((j) => j.userId === joinedId);
    await expect(find()).resolves.toBeNull();
  });

  it('refuses a host image with no hat', async () => {
    hats = [];
    await expect(find()).resolves.toBeNull();
  });

  it("refuses a hat someone else put on the owner's image", async () => {
    hats = [{ entityId: HOST, userId: PLACER, entityOwnerId: OWNER }];
    await expect(find()).resolves.toBeNull();
  });

  it.each(['closed', 'ended'] as const)('refuses while the event is %s', async (state) => {
    access.value = state;
    await expect(find()).resolves.toBeNull();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses for an event with no waiver configured', async () => {
    events.list = [{ ...def, scoring: {} }];
    await expect(find()).resolves.toBeNull();
  });

  it('refuses a submission to your own image', async () => {
    await expect(
      findTeamRemixWaiver({ placerId: OWNER, ownerId: OWNER, hostImageId: HOST })
    ).resolves.toBeNull();
  });
});
