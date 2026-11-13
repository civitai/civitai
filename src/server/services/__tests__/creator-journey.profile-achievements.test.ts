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
  hint?: string | null;
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
      hint: null,
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
  hint: 'Burn the midnight oil',
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
  // Only a special keeps its hint once earned; this one must not reach any viewer.
  hint: 'Keep publishing',
  cosmeticId: 2900,
});

// Distinctive values, so a leak of any of them into the payload is findable as text.
const SCORES = {
  total: 1_234_567,
  models: 700_001,
  images: 300_007,
  articles: 0,
  users: 234_559,
  reportsActioned: 50_050,
  reportsAgainst: -50_050,
  staffAwarded: 1_003,
};

function given(
  rows: ReturnType<typeof row>[],
  user: {
    bannedAt?: Date | null;
    deletedAt?: Date | null;
    privacySettings?: unknown;
    meta?: unknown;
  } = {}
) {
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    bannedAt: user.bannedAt ?? null,
    deletedAt: user.deletedAt ?? null,
    meta: user.meta ?? { scores: SCORES },
    profile: { privacySettings: user.privacySettings ?? null },
  } as never);
  dbMock.dbRead.userCreatorMilestone.findMany.mockResolvedValue(rows as never);
}

describe('getProfileAchievements', () => {
  beforeEach(() => given([SUPERNOVA, MODELS, SECRET, SPARK]));

  // ollie + Justin (card 2026-10-09-001502, default d): hidden achievements are secrets, so a public
  // profile shows an earned one as its art and "Special achievement", never what it is. If you are
  // about to show the name to visitors, that is a product decision to reopen, not a cleanup.
  it('never sends a visitor the name, description or key of an earned hidden achievement', async () => {
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    const secret = result.achievements.find((a) => a.track === 'secret');
    expect(secret).toEqual({
      key: 'secret:1',
      track: 'secret',
      name: null,
      description: null,
      hint: null,
      badgeUrl: 'art-3001',
      achievedAt: OBSERVED,
      spotlit: false,
    });
    const payload = JSON.stringify(result);
    expect(payload).not.toContain('Night Owl');
    expect(payload).not.toContain('2am');
    expect(payload).not.toContain('night-owl');
    expect(payload).not.toContain('midnight oil');
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
      // Justin (2026-10-10): an earned special keeps its hint above the description.
      hint: 'Burn the midnight oil',
    });
    expect(result.achievements.find((a) => a.key === 'create:models-25')?.hint).toBeNull();
  });

  // A visitor who opened a shared special's link gets that card marked, so the tab can ring it. Its
  // key stays masked, and nothing else about it, or about any other secret, changes.
  it('marks the secret a shared link named, and only that one, without its key', async () => {
    const other = row({
      key: 'hidden:early-bird',
      track: 'hidden',
      hidden: true,
      name: 'Early Bird',
      cosmeticId: 3002,
    });
    given([MODELS, SECRET, other]);
    const result = await getProfileAchievements({
      userId: OWNER,
      viewerId: VISITOR,
      spotlight: 'hidden:night-owl',
    });
    expect(result.achievements).toEqual([
      expect.objectContaining({ key: 'create:models-25', spotlit: false }),
      {
        key: 'secret:1',
        track: 'secret',
        name: null,
        description: null,
        hint: null,
        badgeUrl: 'art-3001',
        achievedAt: OBSERVED,
        spotlit: true,
      },
      expect.objectContaining({ key: 'secret:2', name: null, spotlit: false }),
    ]);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain('night-owl');
    expect(payload).not.toContain('Night Owl');
    expect(payload).not.toContain('2am');
    expect(payload).not.toContain('midnight oil');
    expect(payload).not.toContain('early-bird');
  });

  // A hidden tier is linked by its slug, which names its key through the tier list.
  it('marks a hidden tier a shared link named by its slug', async () => {
    const hiddenTier = row({
      key: 'score:legend',
      track: 'score',
      threshold: 5000000,
      hidden: true,
      name: 'Legend',
      cosmeticId: 4000,
    });
    given([MODELS, hiddenTier]);
    const result = await getProfileAchievements({
      userId: OWNER,
      viewerId: VISITOR,
      spotlight: 'legend',
    });
    expect(result.tiers).toEqual([]);
    expect(result.achievements.map((a) => [a.key, a.name, a.spotlit])).toEqual([
      ['create:models-25', '25 Models', false],
      ['secret:1', null, true],
    ]);
  });

  it('marks nothing for a link naming a secret the creator does not hold', async () => {
    const plain = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    const guessed = await getProfileAchievements({
      userId: OWNER,
      viewerId: VISITOR,
      spotlight: 'hidden:night-owk',
    });
    expect(guessed).toEqual(plain);
  });

  it('lists held tiers lowest first and keeps them out of the achievements', async () => {
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(result.tiers.map((t) => t.key)).toEqual(['score:spark', 'score:supernova']);
    expect(result.achievements.map((a) => a.key)).toEqual(['create:models-25', 'secret:1']);
  });

  // The exact score is self-only (brief): the payload has no score and no thresholds to infer one from.
  it('carries no score points and no thresholds', async () => {
    const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
    expect(dbMock.dbRead.user.findUnique.mock.calls[0][0]).toEqual({
      where: { id: OWNER },
      select: {
        bannedAt: true,
        deletedAt: true,
        meta: true,
        profile: { select: { privacySettings: true } },
      },
    });
    // Exact shapes, so any field added to the public payload has to be added here on purpose.
    expect(Object.keys(result).sort()).toEqual(['achievements', 'scoreSplit', 'tiers']);
    expect(Object.keys(result.scoreSplit ?? {}).sort()).toEqual([
      'articles',
      'images',
      'models',
      'users',
    ]);
    for (const tier of result.tiers)
      expect(Object.keys(tier).sort()).toEqual(['achievedAt', 'badgeUrl', 'key', 'name']);
    for (const achievement of result.achievements)
      expect(Object.keys(achievement).sort()).toEqual([
        'achievedAt',
        'badgeUrl',
        'description',
        'hint',
        'key',
        'name',
        'spotlit',
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
          hint: true,
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
      scoreSplit: null,
    });
  });

  describe('score split', () => {
    it('gives a visitor whole-percent shares of the positive categories', async () => {
      const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
      expect(result.scoreSplit).toEqual({ models: 57, images: 24, articles: 0, users: 19 });
    });

    it('never sends a visitor a point value, total, penalty, report or staff award', async () => {
      const payload = JSON.stringify(
        await getProfileAchievements({ userId: OWNER, viewerId: VISITOR })
      );
      for (const value of Object.values(SCORES).filter((v) => v !== 0))
        expect(payload).not.toContain(String(Math.abs(value)));
      expect(payload).not.toMatch(/reports|staffAwarded|total/);
    });

    it('sends the owner the same shares, not their points', async () => {
      const owner = await getProfileAchievements({ userId: OWNER, viewerId: OWNER });
      expect(owner.scoreSplit).toEqual({ models: 57, images: 24, articles: 0, users: 19 });
      expect(JSON.stringify(owner)).not.toContain('700001');
    });

    it('is left out when the owner turns it off', async () => {
      given([SUPERNOVA, MODELS], { privacySettings: { showScoreSplit: false } });
      const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
      expect(result.tiers).not.toEqual([]);
      expect(result.scoreSplit).toBeNull();
    });

    it('is left out for the owner too when they turn it off', async () => {
      given([SUPERNOVA], { privacySettings: { showScoreSplit: false } });
      expect(
        (await getProfileAchievements({ userId: OWNER, viewerId: OWNER })).scoreSplit
      ).toBeNull();
    });

    it('goes with a hidden tier only for the owner, who alone sees that tier', async () => {
      const hiddenTier = row({
        key: 'score:mythic',
        track: 'score',
        threshold: 5000000,
        hidden: true,
        name: 'Mythic',
        cosmeticId: 4000,
      });
      given([hiddenTier, MODELS]);
      expect(
        (await getProfileAchievements({ userId: OWNER, viewerId: VISITOR })).scoreSplit
      ).toBeNull();
      expect(
        (await getProfileAchievements({ userId: OWNER, viewerId: OWNER })).scoreSplit
      ).not.toBeNull();
    });

    it('is shown while any tier badge still shows', async () => {
      given([SUPERNOVA, SPARK], { privacySettings: { hiddenBadgeIds: [2864] } });
      const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
      expect(result.tiers.map((t) => t.key)).toEqual(['score:spark']);
      expect(result.scoreSplit).not.toBeNull();
    });

    it('is shown when the owner never chose', async () => {
      given([SUPERNOVA], { privacySettings: { showBadges: true } });
      const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
      expect(result.scoreSplit).not.toBeNull();
    });

    it.each([
      ['hides every badge', { privacySettings: { showBadges: false } }],
      ['hides their tier badges', { privacySettings: { hiddenBadgeIds: [2864, 2865] } }],
    ])('is left out when the owner %s', async (_, user) => {
      given([SUPERNOVA, SPARK, MODELS], user);
      const result = await getProfileAchievements({ userId: OWNER, viewerId: VISITOR });
      expect(result.tiers).toEqual([]);
      expect(result.scoreSplit).toBeNull();
    });

    it('is left out for a creator with no tier', async () => {
      given([MODELS]);
      expect(
        (await getProfileAchievements({ userId: OWNER, viewerId: VISITOR })).scoreSplit
      ).toBeNull();
    });

    it('is left out when no category is positive', async () => {
      given([SUPERNOVA], { meta: { scores: { total: -5000, reportsAgainst: -5000, models: 0 } } });
      expect(
        (await getProfileAchievements({ userId: OWNER, viewerId: VISITOR })).scoreSplit
      ).toBeNull();
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
