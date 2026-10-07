// A zone behind UTC, so a crossing early on the 1st (UTC) would print the previous month if the
// card formatted in local time.
process.env.TZ = 'America/Los_Angeles';

import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  excluded: vi.fn(async (): Promise<number[]> => []),
  flagOn: vi.fn(async (_user: { id: number; isModerator: boolean }) => true),
  pictures: vi.fn(async (_ids: number[]): Promise<Record<number, unknown>> => ({})),
}));
vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricExcluded>()),
  getMetricExcludedUserIdsOrThrow: mocks.excluded,
}));
vi.mock('~/server/services/creator-journey-flag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof JourneyFlag>()),
  isCreatorJourneyOnFor: mocks.flagOn,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getProfilePicturesForUsers: mocks.pictures,
}));

import type * as MetricExcluded from '~/server/services/metric-excluded-users.service';
import type * as JourneyFlag from '~/server/services/creator-journey-flag.service';
import type * as UserService from '~/server/services/user.service';
import { getMilestoneShareCard } from '~/server/services/creator-milestone-share.service';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';
import {
  parseMilestoneShareId,
  SCORE_TIERS,
  scoreTierKey,
} from '~/shared/constants/creator-journey.constants';
import type { ScoreTierSlug } from '~/shared/constants/creator-journey.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261005120000_creator_milestone/migration.sql'
);

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);

const NOW = new Date('2026-11-15T12:00:00Z');
// 03:00 UTC on Nov 1 is still Oct 31 in Los Angeles.
const CROSSED = '2026-11-01 03:00:00';
const CREATOR = 10;

type UserFlags = { muted?: boolean; image?: string | null; optedOut?: boolean };
const addUser = (id: number, flags: UserFlags = {}) =>
  q(`INSERT INTO "User" (id, username, image, muted, settings) VALUES ($1, $2, $3, $4, $5)`, [
    id,
    `u${id}`,
    flags.image === undefined ? null : flags.image,
    !!flags.muted,
    JSON.stringify(flags.optedOut ? { hideFromCreatorShowcase: true } : {}),
  ]);

/** `silent` mirrors the grant writer: a silent (backfill) grant stamps seenAt equal to achievedAt. */
const grant = (userId: number, slug: ScoreTierSlug, silent = false) =>
  q(
    `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "achievedAt", "seenAt")
     VALUES ($1, $2, $3::timestamp, CASE WHEN $4::boolean THEN $3::timestamp END)`,
    [userId, scoreTierKey(slug), CROSSED, silent]
  );

async function attachBadge(slug: ScoreTierSlug) {
  const { rows } = await q(
    `INSERT INTO "Cosmetic" (data) VALUES ('{"url":"badge-art"}') RETURNING id`
  );
  const id = (rows[0] as { id: number }).id;
  await q(`UPDATE "CreatorMilestone" SET "cosmeticId" = $1 WHERE key = $2`, [
    id,
    scoreTierKey(slug),
  ]);
  return id;
}

const setPrivacy = (userId: number, settings: Record<string, unknown>) =>
  q(`INSERT INTO "UserProfile" ("userId", "privacySettings") VALUES ($1, $2)`, [
    userId,
    JSON.stringify(settings),
  ]);

const card = (slug: ScoreTierSlug = 'supernova', userId = CREATOR) =>
  getMilestoneShareCard({ userId, slug }, { pg, now: NOW });

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text, image text,
      "isModerator" boolean NOT NULL DEFAULT false, muted boolean NOT NULL DEFAULT false,
      "deletedAt" timestamp(3), "bannedAt" timestamp(3),
      "excludeFromLeaderboards" boolean NOT NULL DEFAULT false, settings jsonb DEFAULT '{}');
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, data jsonb);
    CREATE TABLE "UserStrike" ("userId" int NOT NULL, status text NOT NULL,
      "expiresAt" timestamp(3) NOT NULL);
    CREATE TABLE "UserProfile" ("userId" int PRIMARY KEY, "privacySettings" jsonb);
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  mocks.excluded.mockReset().mockResolvedValue([]);
  mocks.flagOn.mockReset().mockResolvedValue(true);
  mocks.pictures.mockReset().mockResolvedValue({});
  await holder.db.exec(`
    TRUNCATE "UserCreatorMilestone", "UserStrike", "UserProfile", "User";
    UPDATE "CreatorMilestone" SET "cosmeticId" = NULL;
  `);
});

describe('milestone share card', () => {
  it('renders an observed crossing with the tier, the UTC month and the badge art', async () => {
    await addUser(CREATOR);
    await attachBadge('supernova');
    await grant(CREATOR, 'supernova');

    const result = await card();

    expect(result).toMatchObject({
      username: `u${CREATOR}`,
      tierName: 'Supernova',
      accent: '#ae3ec9',
      reached: 'November 2026',
    });
    expect(result?.badgeUrl).toContain('badge-art');
    expect(mocks.flagOn).toHaveBeenCalledWith({ id: CREATOR, isModerator: false });
  });

  it('falls back for a backfilled (caught-up) grant, which has no observed crossing', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova', true);
    expect(await card()).toBeNull();
  });

  it('falls back for a tier the creator does not hold', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'nova');
    expect(await card('supernova')).toBeNull();
    expect(await card('nova')).not.toBeNull();
  });

  it('falls back when the owner hides that badge, or all badges, on their profile', async () => {
    const OTHER = 11;
    await addUser(CREATOR);
    await addUser(OTHER);
    const badge = await attachBadge('supernova');
    await grant(CREATOR, 'supernova');
    await grant(OTHER, 'supernova');
    await setPrivacy(CREATOR, { hiddenBadgeIds: [badge] });
    await setPrivacy(OTHER, { showBadges: false });

    expect(await card('supernova', CREATOR)).toBeNull();
    expect(await card('supernova', OTHER)).toBeNull();
  });

  it('falls back when the flag is off for the OWNER', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova');
    mocks.flagOn.mockResolvedValue(false);
    expect(await card()).toBeNull();
  });

  it('falls back for muted, actively struck and metric-suppressed owners', async () => {
    const [MUTED, STRUCK, SUPPRESSED, GOOD] = [11, 12, 13, 14];
    await addUser(MUTED, { muted: true });
    for (const id of [STRUCK, SUPPRESSED, GOOD]) await addUser(id);
    for (const id of [MUTED, STRUCK, SUPPRESSED, GOOD]) await grant(id, 'supernova');
    await q(`INSERT INTO "UserStrike" VALUES ($1, 'Active', '2026-12-01')`, [STRUCK]);
    mocks.excluded.mockResolvedValue([SUPPRESSED]);

    const rendered = [];
    for (const id of [MUTED, STRUCK, SUPPRESSED, GOOD])
      if (await card('supernova', id)) rendered.push(id);
    expect(rendered).toEqual([GOOD]);
  });

  // Decided with the lead: hiding from the showcase is not hiding the badge. The creator posts this
  // card about themselves, so do not add the showcase opt-out to its filter.
  it('still renders for a creator who opted out of the showcase', async () => {
    await addUser(CREATOR, { optedOut: true });
    await grant(CREATOR, 'supernova');
    expect(await card()).not.toBeNull();
  });

  it('shows a safe profile picture, else falls back to the account image, never an NSFW one', async () => {
    await addUser(CREATOR, { image: 'https://example.com/avatar.png' });
    await grant(CREATOR, 'supernova');

    mocks.pictures.mockResolvedValue({
      [CREATOR]: { url: 'safe-pic', nsfwLevel: 1, type: 'image' },
    });
    expect((await card())?.avatarUrl).toContain('safe-pic');

    mocks.pictures.mockResolvedValue({
      [CREATOR]: { url: 'nsfw-pic', nsfwLevel: 4, type: 'image' },
    });
    expect((await card())?.avatarUrl).toBe('https://example.com/avatar.png');
  });
});

describe('share id', () => {
  it('reads `<userId>.<tierSlug>` for every score tier and nothing else', () => {
    expect(parseMilestoneShareId('42.supernova')).toEqual({ userId: 42, slug: 'supernova' });
    for (const raw of [
      '42.score:legend',
      '42.unknown',
      '0.legend',
      '-1.legend',
      '42',
      '9999999999.legend',
    ])
      expect(parseMilestoneShareId(raw), raw).toBeNull();
  });

  it('SCORE_TIERS names exactly the registry score tiers', () => {
    const registryTiers = Object.keys(creatorMilestoneRegistry).filter((key) =>
      key.startsWith('score:')
    );
    expect(SCORE_TIERS.map((tier) => scoreTierKey(tier.slug))).toEqual(registryTiers);
  });
});
