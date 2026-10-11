// A zone behind UTC: the crossing below is Oct 31 here and Nov 1 in UTC, so a card that formatted the
// month in local time would print the wrong one.
process.env.TZ = 'America/Los_Angeles';

import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  excluded: vi.fn(async (): Promise<number[]> => []),
  flagOn: vi.fn(async (_user: { id: number; isModerator: boolean }) => true),
}));
vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricExcluded>()),
  getMetricExcludedUserIdsOrThrow: mocks.excluded,
}));
vi.mock('~/server/services/creator-journey-flag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof JourneyFlag>()),
  isCreatorJourneyOnFor: mocks.flagOn,
}));

import type * as MetricExcluded from '~/server/services/metric-excluded-users.service';
import type * as JourneyFlag from '~/server/services/creator-journey-flag.service';
import {
  achievementShareLine,
  getMilestoneShareCard,
  getMilestoneShareStates,
  isMilestoneShareable,
} from '~/server/services/creator-milestone-share.service';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';
import {
  milestoneOgEndpoint,
  milestoneKeyOfShareToken,
  milestoneShareToken,
  parseMilestoneShareId,
  parseMilestoneShareToken,
  SCORE_TIERS,
  scoreTierKey,
  scoreTierSlugFromKey,
} from '~/shared/constants/creator-journey.constants';
import type { ScoreTierSlug } from '~/shared/constants/creator-journey.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261005120000_creator_milestone/migration.sql'
);

const TIMESTAMP_OID = 1114;
const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);

const NOW = new Date('2026-11-15T12:00:00Z');
const CROSSED = '2026-11-01 03:00:00';
const CREATOR = 10;

type UserFlags = { muted?: boolean; image?: string | null; optedOut?: boolean };
const addUser = (id: number, flags: UserFlags = {}) =>
  q(`INSERT INTO "User" (id, username, image, muted, settings) VALUES ($1, $2, $3, $4, $5)`, [
    id,
    `u${id}`,
    flags.image ?? null,
    !!flags.muted,
    JSON.stringify(flags.optedOut ? { hideFromCreatorShowcase: true } : {}),
  ]);

/**
 * Mirrors the grant writer: a silent (backfill) grant stamps seenAt equal to achievedAt; an announced
 * one starts unseen, and opening the celebration later stamps seenAt with that later time.
 */
const grant = (
  userId: number,
  slug: ScoreTierSlug,
  seen: 'unseen' | 'silent' | 'later' = 'unseen'
) =>
  q(
    `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "achievedAt", "seenAt")
     VALUES ($1, $2, $3::timestamp, CASE $4
       WHEN 'silent' THEN $3::timestamp
       WHEN 'later' THEN $3::timestamp + interval '2 days' END)`,
    [userId, scoreTierKey(slug), CROSSED, seen]
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

type Wearing = { equipped?: boolean | string; toContent?: number };
async function wear(userId: number, type: string, data: Record<string, unknown>, at: Wearing = {}) {
  const { rows } = await q(`INSERT INTO "Cosmetic" (type, data) VALUES ($1, $2) RETURNING id`, [
    type,
    JSON.stringify(data),
  ]);
  await q(
    `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "equippedAt", "equippedToId")
     VALUES ($1, $2, $3::timestamp, $4)`,
    [
      userId,
      (rows[0] as { id: number }).id,
      at.equipped === false ? null : typeof at.equipped === 'string' ? at.equipped : CROSSED,
      at.toContent ?? null,
    ]
  );
}

const setPrivacy = (userId: number, settings: Record<string, unknown>) =>
  q(`INSERT INTO "UserProfile" ("userId", "privacySettings") VALUES ($1, $2)`, [
    userId,
    JSON.stringify(settings),
  ]);

type Picture = {
  nsfwLevel: number;
  ingestion?: string;
  tosViolation?: boolean;
  needsReview?: string;
};
async function setPicture(userId: number, url: string, picture: Picture) {
  const { rows } = await q(
    `INSERT INTO "Image" (url, type, "nsfwLevel", ingestion, "tosViolation", "needsReview")
     VALUES ($1, 'image', $2, $3, $4, $5) RETURNING id`,
    [
      url,
      picture.nsfwLevel,
      picture.ingestion ?? 'Scanned',
      !!picture.tosViolation,
      picture.needsReview ?? null,
    ]
  );
  await q(`UPDATE "User" SET "profilePictureId" = $1 WHERE id = $2`, [
    (rows[0] as { id: number }).id,
    userId,
  ]);
}

const card = (slug: ScoreTierSlug = 'supernova', userId = CREATOR) =>
  getMilestoneShareCard({ userId, milestone: slug }, { pg, now: NOW });

beforeAll(async () => {
  // The app reads `timestamp` as UTC (src/server/db/appsDb.ts); PGlite's default reads it as local.
  holder.db = new PGlite({
    parsers: { [TIMESTAMP_OID]: (value: string) => new Date(value.replace(' ', 'T') + 'Z') },
  });
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text, image text, "profilePictureId" int,
      "isModerator" boolean NOT NULL DEFAULT false, muted boolean NOT NULL DEFAULT false,
      "deletedAt" timestamp(3), "bannedAt" timestamp(3),
      "excludeFromLeaderboards" boolean NOT NULL DEFAULT false, settings jsonb DEFAULT '{}');
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" ("userId" int NOT NULL, "cosmeticId" int NOT NULL,
      "equippedAt" timestamp(3), "equippedToId" int);
    CREATE TABLE "Image" (id serial PRIMARY KEY, url text, type text, "nsfwLevel" int,
      ingestion text, "tosViolation" boolean NOT NULL DEFAULT false, "needsReview" text);
    CREATE TABLE "UserStrike" ("userId" int NOT NULL, status text NOT NULL,
      "expiresAt" timestamp(3) NOT NULL);
    CREATE TABLE "UserProfile" ("userId" int PRIMARY KEY, "privacySettings" jsonb);
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  mocks.excluded.mockReset().mockResolvedValue([]);
  mocks.flagOn.mockReset().mockResolvedValue(true);
  await holder.db.exec(`
    TRUNCATE "UserCreatorMilestone", "UserStrike", "UserProfile", "User", "Image", "UserCosmetic";
    UPDATE "CreatorMilestone" SET "cosmeticId" = NULL;
  `);
});

describe('milestone share card', () => {
  // A plain resize of the art comes back from the image CDN as a JPEG, which drew every tier badge on
  // a black square. Only the optimized variant keeps the transparency; the og route re-encodes it.
  it('asks for the transparent (optimized) variant of every piece of art', async () => {
    await addUser(CREATOR);
    await attachBadge('supernova');
    await grant(CREATOR, 'supernova');
    await wear(CREATOR, 'ProfileDecoration', { url: 'frame-art', offset: '30%' });
    await wear(CREATOR, 'Badge', { url: 'profile-badge-art' });

    const result = await card();

    const urls = [result?.badgeUrl, result?.decoration?.url, result?.profileBadgeUrl];
    expect(
      urls.map((url) => url?.split('/').at(-2)?.split(',').includes('optimized=true'))
    ).toEqual([true, true, true]);
  });

  it("wears the creator's profile frame and badge, the way their avatar does", async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova');
    await wear(CREATOR, 'ProfileDecoration', { url: 'frame-art', offset: '30%' });
    await wear(CREATOR, 'Badge', { url: 'profile-badge-art' });

    const result = await card();

    expect(result?.decoration).toMatchObject({ offset: '30%' });
    expect(result?.decoration?.url).toContain('frame-art/anim');
    expect(result?.profileBadgeUrl).toContain('profile-badge-art/anim');
  });

  it("shows only this creator's cosmetics, never another wearer's", async () => {
    await addUser(CREATOR);
    await addUser(CREATOR + 1);
    await grant(CREATOR, 'supernova');
    await wear(CREATOR + 1, 'ProfileDecoration', { url: 'other-frame' });
    await wear(CREATOR + 1, 'Badge', { url: 'other-badge' });

    expect(await card()).toMatchObject({ decoration: null, profileBadgeUrl: null });
  });

  it('wears the most recently equipped one when two of a kind are worn', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova');
    await wear(CREATOR, 'Badge', { url: 'old-badge' }, { equipped: '2026-01-01 00:00:00' });
    await wear(CREATOR, 'Badge', { url: 'new-badge' }, { equipped: '2026-06-01 00:00:00' });
    await wear(CREATOR, 'Badge', { url: 'mid-badge' }, { equipped: '2026-03-01 00:00:00' });

    expect((await card())?.profileBadgeUrl).toContain('new-badge/anim');
  });

  it('leaves off a cosmetic that is owned but not worn, or worn on a piece of content', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova');
    await wear(CREATOR, 'ProfileDecoration', { url: 'frame-art' }, { equipped: false });
    await wear(CREATOR, 'Badge', { url: 'profile-badge-art' }, { toContent: 77 });

    const result = await card();

    expect(result).toMatchObject({ decoration: null, profileBadgeUrl: null });
  });

  it('renders an observed crossing with the tier, the UTC month and the badge art', async () => {
    await addUser(CREATOR);
    await attachBadge('supernova');
    await grant(CREATOR, 'supernova');

    const result = await card();

    expect(result).toMatchObject({
      username: `u${CREATOR}`,
      name: 'Supernova',
      accent: '#ae3ec9',
      reached: 'November 2026',
    });
    expect(result?.badgeUrl).toContain('badge-art');
    expect(mocks.flagOn).toHaveBeenCalledWith({ id: CREATOR, isModerator: false });
  });

  // The usual way a card is shared: the creator opened the celebration first, so seenAt is set.
  it('renders a crossing the creator has already seen', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova', 'later');
    expect(await card()).toMatchObject({ reached: 'November 2026' });
  });

  // Decided with the lead: at launch every tier held was backfilled, so refusing them offered nobody a
  // card. Its achievedAt is the backfill's date, so the card names no month, as the journey page does.
  it('renders a backfilled (caught-up) grant, with no month', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova', 'silent');
    expect(await card()).toMatchObject({ name: 'Supernova', reached: null });
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
    // The public, un-flagged profile check must refuse too.
    expect(
      await isMilestoneShareable({ userId: CREATOR, milestone: 'supernova' }, { pg, now: NOW })
    ).toBe(false);
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
});

describe('share card avatar', () => {
  const avatarFor = async (picture?: Picture) => {
    await addUser(CREATOR, { image: 'https://example.com/oauth-avatar.png' });
    await grant(CREATOR, 'supernova');
    if (picture) await setPicture(CREATOR, 'profile-pic', picture);
    return (await card())?.avatarUrl;
  };

  it('shows a scanned, safe profile picture', async () => {
    expect(await avatarFor({ nsfwLevel: 1 })).toContain('profile-pic');
  });

  it.each([
    ['NSFW', { nsfwLevel: 4 }],
    ['blocked by moderation', { nsfwLevel: 1, ingestion: 'Blocked' }],
    ['not yet scanned', { nsfwLevel: 1, ingestion: 'Pending' }],
    ['a ToS violation', { nsfwLevel: 1, tosViolation: true }],
    ['awaiting review', { nsfwLevel: 1, needsReview: 'minor' }],
  ])('shows no avatar for a picture that is %s', async (_, picture) => {
    expect(await avatarFor(picture)).toBeNull();
  });

  // The account image is unscanned, and the server would fetch it from whatever host was stored.
  it('never falls back to the account image', async () => {
    expect(await avatarFor()).toBeNull();
  });
});

describe('profile og:image swap', () => {
  it('is shareable exactly when the card renders', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova');
    await grant(CREATOR, 'nova', 'silent');
    const shareable = (slug: ScoreTierSlug) =>
      isMilestoneShareable({ userId: CREATOR, milestone: slug }, { pg, now: NOW });

    expect(await shareable('supernova')).toBe(true);
    expect(await shareable('nova')).toBe(true);
    expect(await shareable('legend')).toBe(false);
  });

  // Lead's veto: a `?milestone=` link whose card will not render must preview the person, so the
  // profile's og:image is exactly what it is without the param.
  it('keeps the profile’s own og:image when the card will not render', () => {
    const withoutParam = milestoneOgEndpoint(CREATOR, null, undefined);
    expect(withoutParam).toBeUndefined();
    expect(milestoneOgEndpoint(CREATOR, 'legend', false)).toBe(withoutParam);
    expect(milestoneOgEndpoint(CREATOR, 'legend', undefined)).toBe(withoutParam);
    expect(milestoneOgEndpoint(CREATOR, 'legend', true)).toBe(
      `/api/og?type=milestone&id=${CREATOR}.legend`
    );
  });
});

describe('journey page share buttons', () => {
  const tierSlugs = async (userId = CREATOR) =>
    (await getMilestoneShareStates(userId, { pg, now: NOW })).shareable.map(scoreTierSlugFromKey);

  // The button and the card read one rule. If they drift, a shared link previews the bare profile.
  it('offers exactly the tiers whose card renders', async () => {
    await addUser(CREATOR);
    const hidden = await attachBadge('star');
    // Out of ladder order, and both ends of it, so neither order nor an end can be lost unseen.
    await grant(CREATOR, 'legend');
    await grant(CREATOR, 'supernova');
    await grant(CREATOR, 'star');
    await grant(CREATOR, 'nova', 'silent');
    await grant(CREATOR, 'kindle', 'later');
    await grant(CREATOR, 'spark');
    await setPrivacy(CREATOR, { hiddenBadgeIds: [hidden] });

    const expected = ['spark', 'kindle', 'nova', 'supernova', 'legend'];
    expect(await tierSlugs()).toEqual(expected);
    const perTier = [];
    for (const { slug } of SCORE_TIERS)
      if (await isMilestoneShareable({ userId: CREATOR, milestone: slug }, { pg, now: NOW }))
        perTier.push(slug);
    expect(perTier).toEqual(expected);
  });

  it('offers nothing when the owner’s flag is off or the owner is muted', async () => {
    const MUTED = 11;
    await addUser(CREATOR);
    await addUser(MUTED, { muted: true });
    await grant(CREATOR, 'supernova');
    await grant(MUTED, 'supernova');

    expect(await tierSlugs(MUTED)).toEqual([]);
    mocks.flagOn.mockResolvedValue(false);
    expect(await tierSlugs(CREATOR)).toEqual([]);
  });

  it('checks the owner’s flag once, and not at all with nothing to share', async () => {
    await addUser(CREATOR);
    expect(await tierSlugs()).toEqual([]);
    expect(mocks.flagOn).not.toHaveBeenCalled();

    await grant(CREATOR, 'kindle');
    await grant(CREATOR, 'supernova');
    expect(await tierSlugs()).toEqual(['kindle', 'supernova']);
    expect(mocks.flagOn).toHaveBeenCalledTimes(1);
  });
});

describe('score tier slugs', () => {
  // The grant registry and the share id are both built from SCORE_TIERS, so a renamed slug moves
  // every code path at once. The seeded rows do not move: a rename would re-grant everyone.
  it('SCORE_TIERS names exactly the seeded score-tier rows', async () => {
    const { rows } = await q(
      `SELECT key FROM "CreatorMilestone" WHERE track = 'score' ORDER BY "sortOrder"`
    );
    expect(SCORE_TIERS.map((tier) => scoreTierKey(tier.slug))).toEqual(
      (rows as { key: string }[]).map((row) => row.key)
    );
  });
});

describe('share id', () => {
  it('reads `<userId>.<tierSlug>` for every score tier and nothing else', () => {
    expect(parseMilestoneShareId('42.supernova')).toEqual({ userId: 42, milestone: 'supernova' });
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
});

describe('achievement share cards', () => {
  const addMilestone = (
    key: string,
    track: string,
    name: string,
    threshold: number | null,
    hidden = track === 'hidden'
  ) =>
    q(
      `INSERT INTO "CreatorMilestone" (key, track, name, threshold, hidden, hint, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (key) DO UPDATE SET hidden = EXCLUDED.hidden`,
      [key, track, name, threshold, hidden, 'Top of the board.', 'Only you see this.']
    );
  const grantKey = (userId: number, key: string) =>
    q(
      `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "achievedAt") VALUES ($1, $2, $3)`,
      [userId, key, CROSSED]
    );
  const achievementCard = (milestone: string, userId = CREATOR) =>
    getMilestoneShareCard({ userId, milestone }, { pg, now: NOW });
  const addBadge = async (key: string) => {
    const { rows } = await q(`INSERT INTO "Cosmetic" (data) VALUES ('{"url":"a"}') RETURNING id`);
    const id = (rows[0] as { id: number }).id;
    await q(`UPDATE "CreatorMilestone" SET "cosmeticId" = $1 WHERE key = $2`, [id, key]);
    return id;
  };

  beforeEach(async () => {
    await addMilestone('reach:downloads-10000', 'reach', '10k Downloads', 10000);
    await addMilestone('create:models-1', 'create', 'First Model', 1);
    await addMilestone('hidden:vwjxua', 'hidden', 'Number One', null);
  });

  it('renders an achievement with its track, accent and a line for strangers', async () => {
    await addUser(CREATOR);
    await grantKey(CREATOR, 'reach:downloads-10000');

    expect(await achievementCard('reach:downloads-10000')).toMatchObject({
      name: '10k Downloads',
      eyebrow: 'Reach Achievement',
      accent: '#f59f00',
      line: 'One model reached 10,000 downloads',
      reachedVerb: 'Earned',
      reached: 'November 2026',
    });
  });

  // Decided with Justin: a shared special stays secret, as a visitor to the profile sees it masked.
  // Its art stays: visitors already see it on the profile, and the mockup Justin chose shows it.
  it('masks a special achievement: its art, but no name anywhere on the card', async () => {
    await addUser(CREATOR);
    await addBadge('hidden:vwjxua');
    await grantKey(CREATOR, 'hidden:vwjxua');

    const result = await achievementCard('hidden:vwjxua');

    expect(result).toMatchObject({
      name: 'Unlocked a secret',
      eyebrow: 'Special Achievement',
      line: 'What it takes stays hidden. Can you find it?',
    });
    expect(result?.badgeUrl?.startsWith('a/anim=false')).toBe(true);
    // The card read selects no hint or description today; these two are a tripwire for a future one.
    const text = JSON.stringify(result);
    for (const secret of ['Number One', 'Top of the board.', 'Only you see this.'])
      expect(text, secret).not.toContain(secret);
  });

  // The profile masks by the `hidden` column, so the card does too: not by track or key prefix,
  // which agree with it in today's data only by convention.
  it('masks by the hidden column, whatever the track or key says', async () => {
    await addUser(CREATOR);
    await addMilestone('create:models-1', 'create', 'First Model', 1, true);
    await grantKey(CREATOR, 'create:models-1');

    expect(await achievementCard('create:models-1')).toMatchObject({
      name: 'Unlocked a secret',
      eyebrow: 'Special Achievement',
    });
    expect((await getMilestoneShareStates(CREATOR, { pg, now: NOW })).secret).toEqual([
      'create:models-1',
    ]);
  });

  // The other direction: a key that looks secret is not masked unless the column says so.
  it('does not mask a milestone the hidden column leaves visible, whatever its key', async () => {
    await addUser(CREATOR);
    await addMilestone('hidden:vwjxua', 'hidden', 'Number One', null, false);
    await grantKey(CREATOR, 'hidden:vwjxua');

    expect(await achievementCard('hidden:vwjxua')).toMatchObject({ name: 'Number One' });
    expect((await getMilestoneShareStates(CREATOR, { pg, now: NOW })).secret).toEqual([]);
  });

  // A hidden tier is a secret like any other on the profile, so its card is masked as a special's is.
  it('masks a hidden score tier as a special', async () => {
    await addUser(CREATOR);
    await grant(CREATOR, 'supernova');
    await q(`UPDATE "CreatorMilestone" SET hidden = true WHERE key = 'score:supernova'`);
    try {
      expect(await achievementCard('supernova')).toMatchObject({
        name: 'Unlocked a secret',
        eyebrow: 'Special Achievement',
        line: 'What it takes stays hidden. Can you find it?',
      });
    } finally {
      await q(`UPDATE "CreatorMilestone" SET hidden = false WHERE key = 'score:supernova'`);
    }
  });

  it('lists a secret hidden on the profile under the hint, not as a shareable secret', async () => {
    await addUser(CREATOR);
    const badge = await addBadge('hidden:vwjxua');
    await grantKey(CREATOR, 'hidden:vwjxua');
    await setPrivacy(CREATOR, { hiddenBadgeIds: [badge] });

    expect(await getMilestoneShareStates(CREATOR, { pg, now: NOW })).toEqual({
      shareable: [],
      hiddenOnProfile: ['hidden:vwjxua'],
      secret: [],
    });
  });

  it('falls back for an achievement the creator does not hold, or hides on their profile', async () => {
    const OTHER = 11;
    await addUser(CREATOR);
    await addUser(OTHER);
    const badge = await addBadge('create:models-1');
    await grantKey(CREATOR, 'create:models-1');
    await grantKey(OTHER, 'create:models-1');
    await setPrivacy(OTHER, { hiddenBadgeIds: [badge] });

    expect(await achievementCard('reach:downloads-10000')).toBeNull();
    expect(await achievementCard('create:models-1')).not.toBeNull();
    expect(await achievementCard('create:models-1', OTHER)).toBeNull();
  });

  it('lists shareable milestones and the ones hidden on the profile, in one read', async () => {
    await addUser(CREATOR);
    const badge = await addBadge('create:models-1');
    await grant(CREATOR, 'spark');
    await grantKey(CREATOR, 'create:models-1');
    await grantKey(CREATOR, 'reach:downloads-10000');
    await setPrivacy(CREATOR, { hiddenBadgeIds: [badge] });

    const states = await getMilestoneShareStates(CREATOR, { pg, now: NOW });

    expect([...states.shareable].sort()).toEqual(['reach:downloads-10000', 'score:spark']);
    expect(states.hiddenOnProfile).toEqual(['create:models-1']);
    expect(states.secret).toEqual([]);
    // The card agrees with the list for every key, so a button never previews the bare profile.
    for (const key of states.shareable)
      expect(await achievementCard(milestoneShareToken(key)), key).not.toBeNull();
    expect(await achievementCard('create:models-1')).toBeNull();
  });

  // Unhiding cannot make a card render for an owner who may not be put on show, so no hint either.
  it('offers no unhide hint to an owner whose cards cannot render anyway', async () => {
    const MUTED = 11;
    await addUser(MUTED, { muted: true });
    await grantKey(MUTED, 'create:models-1');
    await setPrivacy(MUTED, { showBadges: false });

    expect(await getMilestoneShareStates(MUTED, { pg, now: NOW })).toEqual({
      shareable: [],
      hiddenOnProfile: [],
      secret: [],
    });
  });

  it('offers nothing, no hint either, when the owner’s flag is off', async () => {
    await addUser(CREATOR);
    const badge = await addBadge('create:models-1');
    await grantKey(CREATOR, 'create:models-1');
    await grantKey(CREATOR, 'reach:downloads-10000');
    await setPrivacy(CREATOR, { hiddenBadgeIds: [badge] });
    const before = await getMilestoneShareStates(CREATOR, { pg, now: NOW });
    expect(before.hiddenOnProfile).toEqual(['create:models-1']);

    mocks.flagOn.mockResolvedValue(false);
    expect(await getMilestoneShareStates(CREATOR, { pg, now: NOW })).toEqual({
      shareable: [],
      hiddenOnProfile: [],
      secret: [],
    });
  });

  it.each([
    [
      'actively struck',
      async (id: number) => {
        await q(`INSERT INTO "UserStrike" VALUES ($1, 'Active', '2026-12-01')`, [id]);
      },
    ],
    [
      'metric-suppressed',
      async (id: number) => {
        mocks.excluded.mockResolvedValue([id]);
      },
    ],
  ])('renders no achievement card for an owner who is %s', async (_, exclude) => {
    await addUser(CREATOR);
    await grantKey(CREATOR, 'reach:downloads-10000');
    expect(await achievementCard('reach:downloads-10000')).not.toBeNull();
    await exclude(CREATOR);
    expect(await achievementCard('reach:downloads-10000')).toBeNull();
  });
});

describe('achievement share line', () => {
  // Every activity milestone the code can grant gets a line: a new measure without one fails here.
  it('has a line for every activity milestone in the registry, and none for tiers', () => {
    const activity = Object.keys(creatorMilestoneRegistry).filter(
      (key) => !key.startsWith('score:')
    );
    const missing = activity.filter(
      (key) => !achievementShareLine(key, Number(key.split('-').at(-1)))
    );
    expect(activity.length).toBeGreaterThanOrEqual(40);
    expect(missing).toEqual([]);
    expect(achievementShareLine('score:spark', 500)).toBeNull();
    expect(achievementShareLine('hidden:vwjxua', null)).toBeNull();
  });

  it.each([
    ['create:models-1', 1, 'Published a first model'],
    ['create:articles-25', 25, 'Published 25 articles'],
    ['reach:followers-1000', 1000, 'Reached 1,000 followers'],
    ['earn:shop-sales-100000', 100000, '100,000 Buzz in shop sales'],
    ['community:crucible-votes-500', 500, 'Cast 500 Crucible votes'],
    ['compete:wins-1', 1, 'Won a first challenge or Crucible'],
    ['compete:wins-5', 5, 'Won 5 challenges and Crucibles'],
  ])('reads %s as "%s"', (key, threshold, line) => {
    expect(achievementShareLine(key, threshold)).toBe(line);
  });
});

describe('achievement share id', () => {
  // A key the parser refuses would get a button whose link, card and preview swap all fail silently.
  it('parses every milestone key the code can grant, as its share token', () => {
    const keys = Object.keys(creatorMilestoneRegistry);
    expect(keys.length).toBeGreaterThanOrEqual(49);
    expect(
      keys.filter((key) => {
        const token = milestoneShareToken(key);
        return parseMilestoneShareToken(token) !== token || milestoneKeyOfShareToken(token) !== key;
      })
    ).toEqual([]);
  });

  it('reads `<userId>.<achievementKey>`, including a special', () => {
    expect(parseMilestoneShareId('42.reach:downloads-10000')).toEqual({
      userId: 42,
      milestone: 'reach:downloads-10000',
    });
    expect(parseMilestoneShareId('42.hidden:vwjxua')).toEqual({
      userId: 42,
      milestone: 'hidden:vwjxua',
    });
  });

  it.each([
    '42.reach:Downloads-10',
    '42.other:x',
    '42.reach:',
    "42.reach:x' OR 1=1",
    '42.reach:downloads-10000.extra',
    `42.reach:${'a'.repeat(41)}`,
  ])('refuses %s', (raw) => {
    expect(parseMilestoneShareId(raw)).toBeNull();
  });
});
