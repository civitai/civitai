import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/redis/caches', () => ({
  getUserContentOverview: vi.fn(async () => ({})),
  getUserContentOverviewPublic: vi.fn(async () => ({})),
  getUserContentOverviewSfw: vi.fn(async () => ({})),
}));
vi.mock('~/server/search-index', () => ({
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/image.service', () => ({
  enqueueImageIngestion: vi.fn(async () => undefined),
}));

const { getUserWithProfile, updateUserProfile } = await import(
  '~/server/services/user-profile.service'
);

const OWNER = 7;
const CLAIM_KEY = 'tx-claim-3307';
const stored = {
  equippedAt: new Date(),
  cosmeticId: 1,
  obtainedAt: new Date('2026-01-01T00:00:00Z'),
  claimKey: CLAIM_KEY,
  data: null,
  cosmetic: { id: 1, name: 'Badge', type: 'Badge', source: 'Purchase', data: { url: 'b.png' } },
};

/** Returns the stored cosmetic row with only the fields the read selected, as Prisma would. */
function selected(select: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(stored).filter(([key]) => (select as Record<string, boolean>)[key])
  );
}

beforeEach(() => {
  dbMock.dbWrite.user.findUniqueOrThrow.mockImplementation((async (args: {
    select: { cosmetics: { select: Record<string, unknown> } };
  }) => ({
    id: OWNER,
    meta: {},
    settings: null,
    profile: { userId: OWNER },
    cosmetics: [selected(args.select.cosmetics.select)],
  })) as never);
  dbMock.dbRead.userStat.findFirst.mockResolvedValue(null as never);
});

// A profile lists everything a user holds, for anyone who opens it. The claim key picks one holding
// to equip, which only its owner does: their profile editor reads it from here.
describe('the profile read carries claim keys for the owner alone', () => {
  it.each([
    ['a signed-out viewer', {}],
    ['another user', { sessionUserId: 99 }],
    ['a moderator', { sessionUserId: 99, isModerator: true }],
  ])('not for %s', async (_, viewer) => {
    const profile = await getUserWithProfile({ id: OWNER, ...viewer });
    expect(profile.cosmetics).toHaveLength(1);
    expect(profile.cosmetics[0]).toMatchObject({ cosmeticId: 1, claimKey: null });
    expect(JSON.stringify(profile)).not.toContain(CLAIM_KEY);
  });

  it('for the owner', async () => {
    const profile = await getUserWithProfile({ id: OWNER, sessionUserId: OWNER });
    expect(profile.cosmetics[0]).toMatchObject({ cosmeticId: 1, claimKey: CLAIM_KEY });
  });
});

describe('saving a profile answers with the saved profile as its saver sees it', () => {
  beforeEach(() => {
    const tx = {
      userLink: { deleteMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
      userProfile: { update: vi.fn(async () => ({ userId: OWNER, coverImage: null })) },
    };
    dbMock.dbWrite.$transaction.mockImplementation((async (fn: (c: unknown) => unknown) =>
      fn(tx)) as never);
  });

  it('carries no claim keys for a moderator saving it', async () => {
    const saved = await updateUserProfile({ userId: OWNER, sessionUserId: 99, isModerator: true });
    expect(saved.cosmetics[0]).toMatchObject({ cosmeticId: 1, claimKey: null });
  });

  it('carries them for the owner, whose editor caches the answer', async () => {
    const saved = await updateUserProfile({ userId: OWNER, sessionUserId: OWNER });
    expect(saved.cosmetics[0]).toMatchObject({ cosmeticId: 1, claimKey: CLAIM_KEY });
  });
});
