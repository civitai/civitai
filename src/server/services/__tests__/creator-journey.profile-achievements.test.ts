import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getProfileAchievements } from '~/server/services/creator-journey.service';

const OWNER = 7;
const VISITOR = 8;
const OBSERVED = new Date('2026-10-02T03:00:00Z');
const BACKFILLED = new Date('2026-09-01T03:00:00Z');

type Row = {
  key: string;
  track: string;
  threshold?: number | null;
  hidden?: boolean;
  name: string;
  description?: string | null;
  cosmeticId?: number | null;
  observed?: boolean;
};

const row = ({ observed = true, ...m }: Row) => {
  const achievedAt = new Date(observed ? OBSERVED : BACKFILLED);
  return {
    achievedAt,
    // A silent grant marks seenAt equal to achievedAt; an observed one leaves it unseen.
    seenAt: observed ? null : new Date(achievedAt),
    milestone: {
      threshold: null,
      hidden: false,
      description: null,
      cosmeticId: null,
      ...m,
      // Real art is a CDN id that does not name the milestone.
      cosmetic: { data: { url: `art-${m.cosmeticId}` } },
    },
  };
};

const SECRET = row({
  key: 'hidden:night-owl',
  track: 'hidden',
  hidden: true,
  name: 'Night Owl',
  description: 'Publish between 2am and 4am',
  cosmeticId: 3001,
});
const SUPERNOVA = row({
  key: 'score:supernova',
  track: 'score',
  threshold: 100000,
  name: 'Supernova',
  cosmeticId: 2864,
});
const SPARK = row({
  key: 'score:spark',
  track: 'score',
  threshold: 100,
  name: 'Spark',
  cosmeticId: 2865,
  observed: false,
});
const MODELS = row({
  key: 'create:models-25',
  track: 'create',
  threshold: 25,
  name: '25 Models',
  cosmeticId: 2900,
});

function given(
  rows: ReturnType<typeof row>[],
  user: { bannedAt?: Date | null; deletedAt?: Date | null; privacySettings?: unknown } = {}
) {
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    bannedAt: user.bannedAt ?? null,
    deletedAt: user.deletedAt ?? null,
    profile: { privacySettings: user.privacySettings ?? null },
  } as never);
  dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue(rows as never);
}

describe('getProfileAchievements', () => {
  beforeEach(() => given([SUPERNOVA, MODELS, SECRET, SPARK]));

  // ollie + Justin (card 2026-10-09-001502, default d): hidden achievements are secrets, so a public
  // profile shows an earned one as its art and "Secret achievement", never what it is. If you are
  // about to show the name to visitors, that is a product decision to reopen, not a cleanup.
  it('never sends a visitor the name, description or key of an earned hidden achievement', async () => {
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    const secret = result.achievements.find((a) => a.track === 'secret');
    expect(secret).toEqual({
      key: 'secret:1',
      track: 'secret',
      name: null,
      description: null,
      badgeUrl: 'art-3001',
      achievedAt: OBSERVED,
    });
    const payload = JSON.stringify(result);
    expect(payload).not.toContain('Night Owl');
    expect(payload).not.toContain('2am');
    expect(payload).not.toContain('night-owl');
  });

  it('masks it for a signed-out visitor too', async () => {
    const payload = JSON.stringify(await getProfileAchievements({ userId: OWNER }));
    expect(payload).not.toContain('Night Owl');
  });

  it('shows the owner their own secret by name', async () => {
    const result = await getProfileAchievements({ userId: OWNER, viewerId: OWNER });
    expect(result.achievements.find((a) => a.track === 'secret')).toMatchObject({
      key: 'hidden:night-owl',
      name: 'Night Owl',
      description: 'Publish between 2am and 4am',
    });
  });

  it('lists held tiers lowest first and keeps them out of the achievements', async () => {
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(result.tiers.map((t) => t.key)).toEqual(['score:spark', 'score:supernova']);
    expect(result.achievements.map((a) => a.key)).toEqual(['create:models-25', 'secret:1']);
  });

  // The exact score is self-only (brief): the payload has no score and no thresholds to infer one from.
  it('carries no score and no thresholds', async () => {
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(dbMock.dbRead.user.findUnique.mock.calls[0][0]).toEqual({
      where: { id: OWNER },
      select: { bannedAt: true, deletedAt: true, profile: { select: { privacySettings: true } } },
    });
    // Exact shapes, so any field added to the public payload has to be added here on purpose.
    expect(Object.keys(result).sort()).toEqual(['achievements', 'tiers']);
    for (const tier of result.tiers)
      expect(Object.keys(tier).sort()).toEqual(['achievedAt', 'badgeUrl', 'key', 'name']);
    for (const achievement of result.achievements)
      expect(Object.keys(achievement).sort()).toEqual([
        'achievedAt',
        'badgeUrl',
        'description',
        'key',
        'name',
        'track',
      ]);
  });

  it('reads only the owner’s earned rows', async () => {
    await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(dbMock.dbRead.userCreatorMilestone.findMany.mock.calls[0][0]?.where).toEqual({
      userId: OWNER,
    });
    // The mock returns every fixture field whatever is selected, so the select itself is pinned:
    // dropping `hidden` would unmask every secret, and `cosmeticId` would turn off badge privacy.
    expect(dbMock.dbRead.userCreatorMilestone.findMany.mock.calls[0][0]?.select).toEqual({
      achievedAt: true,
      seenAt: true,
      milestone: {
        select: {
          key: true,
          track: true,
          threshold: true,
          hidden: true,
          name: true,
          description: true,
          cosmeticId: true,
          cosmetic: { select: { data: true } },
        },
      },
    });
    expect(dbMock.dbRead.creatorMilestone.findMany).not.toHaveBeenCalled();
  });

  // The section shows the first six as "Latest achievements", and the mock cannot sort, so the
  // query's own order is what is pinned: newest first, then a stable tiebreak for same-night grants.
  it('asks for the newest first', async () => {
    await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(dbMock.dbRead.userCreatorMilestone.findMany.mock.calls[0][0]?.orderBy).toEqual([
      { achievedAt: 'desc' },
      { milestoneKey: 'asc' },
    ]);
  });

  it('keeps the order it was given for achievements', async () => {
    const older = row({ key: 'reach:followers-1000', track: 'reach', name: '1k Followers' });
    given([MODELS, older]);
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(result.achievements.map((a) => a.key)).toEqual([
      'create:models-25',
      'reach:followers-1000',
    ]);
  });

  it('leaves the date off a silently granted achievement', async () => {
    const backfilled = row({
      key: 'create:models-1',
      track: 'create',
      name: 'First Model',
      observed: false,
    });
    given([MODELS, backfilled]);
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(result.achievements.map((a) => [a.key, a.achievedAt])).toEqual([
      ['create:models-25', OBSERVED],
      ['create:models-1', null],
    ]);
  });

  it('leaves the date off a silently granted badge', async () => {
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(result.tiers.find((t) => t.key === 'score:spark')?.achievedAt).toBeNull();
    expect(result.tiers.find((t) => t.key === 'score:supernova')?.achievedAt).toEqual(OBSERVED);
  });

  it('drops a badge the owner hides on their profile', async () => {
    given([SUPERNOVA, MODELS], { privacySettings: { hiddenBadgeIds: [2900] } });
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(result.tiers.map((t) => t.key)).toEqual(['score:supernova']);
    expect(result.achievements).toEqual([]);
  });

  it.each([
    ['hides all badges', { privacySettings: { showBadges: false } }],
    ['is banned', { bannedAt: new Date() }],
    ['is deleted', { deletedAt: new Date() }],
  ])('shows nothing when the owner %s', async (_, user) => {
    given([SUPERNOVA, MODELS, SECRET], user);
    expect(await getProfileAchievements({ userId: OWNER, viewerId: VISITOR })).toEqual({
      tiers: [],
      achievements: [],
    });
  });

  it('treats a hidden tier as a secret for visitors', async () => {
    const hiddenTier = row({
      key: 'score:mythic',
      track: 'score',
      threshold: 5000000,
      hidden: true,
      name: 'Mythic',
      cosmeticId: 4000,
    });
    given([hiddenTier]);
    const visitor = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(visitor.tiers).toEqual([]);
    expect(visitor.achievements).toMatchObject([{ key: 'secret:0', name: null, track: 'secret' }]);
    expect(JSON.stringify(visitor)).not.toContain('Mythic');

    const owner = await getProfileAchievements({ userId: OWNER, viewerId: OWNER });
    expect(owner.tiers.map((t) => t.name)).toEqual(['Mythic']);
  });
});

// Owner means the signed-in viewer is the profile's user. Pinned by text because the procedure needs the
// whole tRPC context; any other source for viewerId (the input, a header) would unmask every secret.
it('takes the viewer from the session, never from the input', () => {
  const router = readFileSync(
    join(process.cwd(), 'src/server/routers/creator-journey.router.ts'),
    'utf8'
  );
  const calls = router.match(/getProfileAchievements\([^)]*\)/g);
  // The session's id goes last, so nothing in the input can override it.
  expect(calls).toEqual(['getProfileAchievements({ ...input, viewerId: ctx.user?.id })']);
});
