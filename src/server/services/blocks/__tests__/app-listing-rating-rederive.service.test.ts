import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';
import type * as AppListingService from '~/server/services/blocks/app-listing.service';

const { bustCatalog, resolveCalls } = vi.hoisted(() => ({
  bustCatalog: vi.fn(async () => undefined),
  /** Every argument the service handed the resolver, which still runs for real. */
  resolveCalls: [] as Array<{ declared: string | null; stored: string | null }>,
}));
vi.mock('~/server/services/blocks/app-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingService>()),
  bustAppListingCatalogCache: () => bustCatalog(),
}));
vi.mock('~/server/services/blocks/app-listing-rating', async (importOriginal) => {
  const actual = await importOriginal<typeof AppListingRating>();
  return {
    ...actual,
    resolveReDerivedListingRating: (
      args: Parameters<typeof actual.resolveReDerivedListingRating>[0]
    ) => {
      resolveCalls.push({ declared: args.declared, stored: args.stored });
      return actual.resolveReDerivedListingRating(args);
    },
  };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import {
  reDeriveListingRatingInTx,
  reDeriveListingRatingsForModeratedImage,
} from '~/server/services/blocks/app-listing-rating-rederive.service';

/**
 * A moderator re-rated an image → the ratings of the live listings that use it.
 *
 * The db is an in-memory store behind the shared mock. Its reads HONOUR the `where` they are
 * handed (and the raw lock statement's own text), so dropping a clause from the code changes
 * what a case sees; `$transaction` snapshots and restores the store on a throw.
 */

type Listing = {
  id: string;
  slug: string;
  kind: 'onsite' | 'offsite';
  status: string;
  revisionOfId: string | null;
  contentRating: string | null;
  iconId: number | null;
  coverId: number | null;
  /** The backing app's own rating; `undefined` = no backing block. */
  declared?: string;
};
type Image = { id: number; nsfwLevel: number; ingestion: string };
type Shot = { appListingId: string; imageId: number | null };
type Event = {
  appListingId: string;
  slug: string;
  action: string;
  actorUserId: number | null;
  reason: string;
  detail: string;
  before: unknown;
  after: unknown;
};

let listings: Listing[];
let images: Image[];
let shots: Shot[];
let events: Event[];
let failEventInsert: boolean;
let lockStatements: string[];
/** Every store call, in order, tagged with the client it went through. */
let ops: string[];
let failUpdateFor: string | null;
/** Listings a moderator granted a media split (`app_listing_red_media`). */
let splitListings: Set<string>;

type Fn = { mockImplementation: (f: (...a: never[]) => unknown) => void };
const fake = (node: unknown, impl: (...a: never[]) => unknown) =>
  (node as Fn).mockImplementation(impl);

/** Only the keys a Prisma `select` asked for, so a dropped projection field reads undefined. */
function pick(row: Record<string, unknown>, select: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

/**
 * One client over the store. `via` tags every call in `ops`, and only writes made through
 * the `tx` client are undone when its transaction throws — so the tests can tell a statement
 * that ran inside the transaction from one that ran beside it on the pool.
 */
function client(via: 'pool' | 'tx', undo: Array<() => void>) {
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const stmt = Prisma.sql(strings, ...(values as Prisma.Sql[]));
      const text = stmt.text.replace(/\s+/g, ' ').trim();
      if (text.includes("to_regclass('app_listing_red_media')")) {
        ops.push(`${via}:split`);
        return [{ present: true, can_select: true, can_insert: true, can_update: true }];
      }
      if (text.includes('FROM app_listing_red_media'))
        return [{ split: splitListings.has(stmt.values[0] as string) }];
      ops.push(`${via}:lock`);
      lockStatements.push(text);
      const [id] = stmt.values as [string];
      return listings
        .filter((l) => l.id === id)
        .filter((l) => !text.includes(`"status" = 'approved'`) || l.status === 'approved')
        .filter((l) => !text.includes(`"revision_of_id" IS NULL`) || l.revisionOfId === null)
        .map((l) => ({ id: l.id }));
    },
    listingFindUnique: async (args: { where: { id: string }; select: Record<string, unknown> }) => {
      ops.push(`${via}:listing`);
      const l = listings.find((x) => x.id === args.where.id);
      if (!l) return null;
      return pick(
        { ...l, appBlock: l.declared === undefined ? null : { contentRating: l.declared } },
        args.select
      );
    },
    shotsFindMany: async (args: { where: { appListingId: string; imageId?: { not: null } } }) => {
      ops.push(`${via}:shots`);
      return shots
        .filter((s) => s.appListingId === args.where.appListingId)
        .filter((s) => !args.where.imageId || s.imageId !== null);
    },
    imageFindMany: async (args: {
      where: { id: { in: number[] } };
      select: Record<string, unknown>;
    }) => {
      ops.push(`${via}:images`);
      return images.filter((i) => args.where.id.in.includes(i.id)).map((i) => pick(i, args.select));
    },
    listingUpdate: async (args: { where: { id: string }; data: { contentRating: string } }) => {
      ops.push(`${via}:update`);
      if (failUpdateFor === args.where.id) throw new Error('deadlock detected');
      const l = listings.find((x) => x.id === args.where.id);
      if (!l) throw new Error('row not found');
      const previous = l.contentRating;
      undo.push(() => {
        listings.find((x) => x.id === args.where.id)!.contentRating = previous;
      });
      Object.assign(l, args.data);
      return l;
    },
    eventFindFirst: async (args: {
      where: { appListingId: string; action: string; detail: string };
      orderBy: Array<{ createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>;
      select: Record<string, unknown>;
    }) => {
      ops.push(`${via}:reviewed`);
      // `events` is in insertion order, which stands in for (createdAt, id). Honour the
      // direction asked for, and refuse a query that does not ask, so "which end" is pinned.
      const direction = args.orderBy?.[0]?.createdAt;
      if (direction !== 'asc' && direction !== 'desc')
        throw new Error('rating-change history read without a createdAt order');
      const matching = events.filter(
        (e) =>
          e.appListingId === args.where.appListingId &&
          e.action === args.where.action &&
          e.detail === args.where.detail
      );
      const hit = direction === 'desc' ? matching[matching.length - 1] : matching[0];
      return hit ? pick(hit, args.select) : null;
    },
    eventCreate: async (args: { data: Event }) => {
      ops.push(`${via}:event`);
      if (failEventInsert)
        throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      events.push(args.data);
      undo.push(() => {
        events = events.filter((e) => e !== args.data);
      });
      return args.data;
    },
  };
}

function prismaShape(c: ReturnType<typeof client>) {
  return {
    $queryRaw: c.$queryRaw,
    appListing: { findUnique: c.listingFindUnique, update: c.listingUpdate },
    appListingScreenshot: { findMany: c.shotsFindMany },
    image: { findMany: c.imageFindMany },
    appListingModerationEvent: { create: c.eventCreate, findFirst: c.eventFindFirst },
  };
}

/** A `tx` for calling the in-transaction function directly. */
const directTx = () => prismaShape(client('tx', [])) as never;

function installStore() {
  const db = dbMock.dbWrite;
  const pool = client('pool', []);

  fake(
    db.appListing.findMany,
    async (args: {
      where: {
        status?: string;
        revisionOfId?: null;
        OR: Array<Record<string, unknown>>;
      };
    }) => {
      ops.push('pool:lookup');
      const { where } = args;
      // The three OR arms, each honoured only if the code asked for it.
      const arms = JSON.stringify(where.OR);
      const imageId = Number(arms.match(/\d+/)![0]);
      return listings
        .filter((l) => !('status' in where) || l.status === where.status)
        .filter((l) => !('revisionOfId' in where) || l.revisionOfId === where.revisionOfId)
        .filter(
          (l) =>
            (arms.includes('"iconId"') && l.iconId === imageId) ||
            (arms.includes('"coverId"') && l.coverId === imageId) ||
            (arms.includes('"screenshots"') &&
              shots.some((s) => s.appListingId === l.id && s.imageId === imageId))
        )
        .map((l) => ({ id: l.id }));
    }
  );
  fake(db.$queryRaw, pool.$queryRaw as never);
  fake(db.appListing.findUnique, pool.listingFindUnique as never);
  fake(db.appListingScreenshot.findMany, pool.shotsFindMany as never);
  fake(db.image.findMany, pool.imageFindMany as never);
  fake(db.appListing.update, pool.listingUpdate as never);
  fake(db.appListingModerationEvent.create, pool.eventCreate as never);
  fake(db.$transaction, async (fn: (tx: unknown) => Promise<unknown>) => {
    const undo: Array<() => void> = [];
    try {
      return await fn(prismaShape(client('tx', undo)));
    } catch (err) {
      undo.reverse().forEach((u) => u());
      throw err;
    }
  });
}

const MOD = 9001;
const ICON = 11;
const COVER = 12;
const SHOT = 13;

/** Declared g, assets {PG, PG13, R}, stored r — the rating a mis-scanned R screenshot leaves. */
function seedMisScanned(over: Partial<Listing> = {}) {
  listings = [
    {
      id: 'apl_a',
      slug: 'app-a',
      kind: 'onsite',
      status: 'approved',
      revisionOfId: null,
      contentRating: 'r',
      iconId: ICON,
      coverId: COVER,
      declared: 'g',
      ...over,
    },
  ];
  images = [
    { id: ICON, nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' },
    { id: COVER, nsfwLevel: NsfwLevel.PG13, ingestion: 'Scanned' },
    { id: SHOT, nsfwLevel: NsfwLevel.R, ingestion: 'Scanned' },
  ];
  shots = [{ appListingId: 'apl_a', imageId: SHOT }];
}

/** The moderator's write: set the image, then run the hook with its previous level. */
async function moderatorRerates(imageId: number, nsfwLevel: number) {
  const image = images.find((i) => i.id === imageId)!;
  const previousNsfwLevel = image.nsfwLevel;
  image.nsfwLevel = nsfwLevel;
  return reDeriveListingRatingsForModeratedImage({
    imageId,
    previousNsfwLevel,
    actorUserId: MOD,
  });
}

const ratingOf = (id: string) => listings.find((l) => l.id === id)!.contentRating;

/** A `rating-change` a moderator's review wrote for `apl_a`, landing on `after`. */
const reviewEvent = (after: string): Event => ({
  appListingId: 'apl_a',
  slug: 'app-a',
  action: 'rating-change',
  actorUserId: MOD,
  reason: `Rating changed at review.`,
  detail: 'review',
  before: { contentRating: 'r' },
  after: { contentRating: after },
});

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  failEventInsert = false;
  lockStatements = [];
  ops = [];
  failUpdateFor = null;
  splitListings = new Set();
  resolveCalls.length = 0;
  seedMisScanned();
  installStore();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('lowering after a moderator corrects a mis-scanned image', () => {
  it('declared g, assets {PG, PG13, R}, stored r: R → PG lowers the listing to pg13, not g', async () => {
    const changed = await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('pg13');
    expect(changed).toEqual([{ appListingId: 'apl_a', before: 'r', after: 'pg13' }]);
    expect(events).toEqual([
      {
        id: expect.stringMatching(/^alme_/),
        appListingId: 'apl_a',
        slug: 'app-a',
        action: 'rating-change',
        actorUserId: MOD,
        reason: 'Rating lowered R → PG-13 after a moderator reviewed an image.',
        detail: 'image-review',
        before: { contentRating: 'r' },
        after: { contentRating: 'pg13' },
      },
    ]);
    expect(bustCatalog).toHaveBeenCalledTimes(1);
  });

  it('never goes below the app’s declared rating: declared r, every asset PG → stays r', async () => {
    seedMisScanned({ declared: 'r', contentRating: 'x' });
    images.find((i) => i.id === COVER)!.nsfwLevel = NsfwLevel.PG;
    images.find((i) => i.id === SHOT)!.nsfwLevel = NsfwLevel.X;

    await moderatorRerates(SHOT, NsfwLevel.PG);

    // x was the X screenshot's doing, so it comes down — to the declared r, not to g.
    expect(ratingOf('apl_a')).toBe('r');
    expect(events.map((e) => e.after)).toEqual([{ contentRating: 'r' }]);
  });

  it('declared r, stored r, every asset PG → untouched, no event', async () => {
    seedMisScanned({ declared: 'r', contentRating: 'r' });
    images.find((i) => i.id === COVER)!.nsfwLevel = NsfwLevel.PG;

    const changed = await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('r');
    expect(changed).toEqual([]);
    expect(events).toEqual([]);
    expect(bustCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ['still scanning', { ingestion: 'Pending', nsfwLevel: NsfwLevel.PG }],
    ['blocked', { ingestion: 'Blocked', nsfwLevel: NsfwLevel.PG }],
    ['scanned but never given a level', { ingestion: 'Scanned', nsfwLevel: 0 }],
  ])('does not lower while another asset is %s', async (_label, cover) => {
    Object.assign(images.find((i) => i.id === COVER)!, cover);

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('r');
    expect(events).toEqual([]);
  });

  it('does not lower while the re-rated image itself is unscanned', async () => {
    images.find((i) => i.id === SHOT)!.ingestion = 'Pending';

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('r');
    expect(events).toEqual([]);
  });

  it('does not lower while an asset’s Image row is missing', async () => {
    images = images.filter((i) => i.id !== COVER);

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('r');
    expect(events).toEqual([]);
  });

  it('does not lower a rating the re-rated image never explained (a review override above the media)', async () => {
    // Stored x, but the image was only ever R: something else put x there.
    seedMisScanned({ contentRating: 'x' });

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('x');
    expect(events).toEqual([]);
  });

  it('does not undo a moderator’s override at review, even once an image re-rate “explains” it', async () => {
    // At a republish re-review a moderator stamped x over media that derived r (app declares g).
    seedMisScanned({ contentRating: 'x' });
    events.push(reviewEvent('x'));
    // The screenshot is re-rated R → X: the media now derives x, which equals stored — no-op…
    await moderatorRerates(SHOT, NsfwLevel.X);
    expect(ratingOf('apl_a')).toBe('x');
    // …so its previous level now "explains" stored x when it is corrected back down.
    await moderatorRerates(SHOT, NsfwLevel.PG13);

    expect(ratingOf('apl_a')).toBe('x');
    expect(events.map((e) => e.detail)).toEqual(['review']);
  });

  it('may still lower to the newest review decision, just not past it', async () => {
    // Reviewed pg13 over media that derived pg; a moderator later raised the screenshot to R.
    seedMisScanned({ contentRating: 'r' });
    images.find((i) => i.id === COVER)!.nsfwLevel = NsfwLevel.PG;
    events.push(reviewEvent('x'), reviewEvent('pg13'), {
      ...reviewEvent('r'),
      detail: 'image-review',
    });

    await moderatorRerates(SHOT, NsfwLevel.PG);

    // The derived target is g; the newest REVIEW decision (pg13, not the older x) bounds it.
    expect(ratingOf('apl_a')).toBe('pg13');
  });

  it('reads the NEWEST review decision when there are several, not the oldest', async () => {
    // An older review held the listing at r; a later review relaxed that decision to pg.
    seedMisScanned({ contentRating: 'r' });
    events.push(reviewEvent('r'), reviewEvent('pg'));

    await moderatorRerates(SHOT, NsfwLevel.PG);

    // Newest (pg) is below the media target, so the correction lands on pg13. The older r
    // would have held the listing at r.
    expect(ratingOf('apl_a')).toBe('pg13');
  });

  it('does not lower without the image’s previous level', async () => {
    images.find((i) => i.id === SHOT)!.nsfwLevel = NsfwLevel.PG;

    await reDeriveListingRatingsForModeratedImage({
      imageId: SHOT,
      previousNsfwLevel: null,
      actorUserId: MOD,
    });

    expect(ratingOf('apl_a')).toBe('r');
    expect(events).toEqual([]);
  });

  it('never lowers an off-site listing, even one with an app attached', async () => {
    seedMisScanned({ kind: 'offsite' });

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('r');
    expect(events).toEqual([]);
  });

  it('never lowers an on-site listing that has no backing app to read a declared rating from', async () => {
    seedMisScanned({ declared: undefined });

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('r');
    expect(events).toEqual([]);
  });
});

/**
 * The floor the resolver is handed. Only the backing app's rating is a declaration here: the
 * display helper's pre-approval fallback to the listing's own rating would make the stored
 * value its own floor. The outcome tests above cannot see that difference (the resolver's
 * result happens to coincide), so the argument itself is pinned.
 */
describe('the declared rating handed to the resolver', () => {
  it('an on-site listing declares through its backing app', async () => {
    seedMisScanned({ declared: 'pg13', contentRating: 'x' });

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(resolveCalls).toEqual([{ declared: 'pg13', stored: 'x' }]);
  });

  it('an off-site listing declares nothing, even with an app attached', async () => {
    seedMisScanned({ kind: 'offsite', declared: 'pg13', contentRating: 'x' });

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(resolveCalls).toEqual([{ declared: null, stored: 'x' }]);
  });

  it('an on-site listing with no backing app declares nothing — not its stored rating', async () => {
    seedMisScanned({ declared: undefined, contentRating: 'x' });

    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(resolveCalls).toEqual([{ declared: null, stored: 'x' }]);
  });
});

describe('raising after a moderator re-rates an image upward', () => {
  it('PG → X raises the listing to x and records it', async () => {
    seedMisScanned({ contentRating: 'r' });

    const changed = await moderatorRerates(ICON, NsfwLevel.X);

    expect(ratingOf('apl_a')).toBe('x');
    expect(changed).toEqual([{ appListingId: 'apl_a', before: 'r', after: 'x' }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'rating-change',
      actorUserId: MOD,
      reason: 'Rating raised R → X after a moderator reviewed an image.',
      detail: 'image-review',
      before: { contentRating: 'r' },
      after: { contentRating: 'x' },
    });
    expect(bustCatalog).toHaveBeenCalledTimes(1);
  });

  it('raises an off-site listing too', async () => {
    seedMisScanned({ kind: 'offsite', declared: undefined, contentRating: 'pg13' });
    images.find((i) => i.id === SHOT)!.nsfwLevel = NsfwLevel.PG;

    await moderatorRerates(COVER, NsfwLevel.R);

    expect(ratingOf('apl_a')).toBe('r');
    expect(events.map((e) => e.reason)).toEqual([
      'Rating raised PG-13 → R after a moderator reviewed an image.',
    ]);
  });

  it('raises even while another asset is unscanned', async () => {
    seedMisScanned({ contentRating: 'r' });
    images.find((i) => i.id === COVER)!.ingestion = 'Pending';

    await moderatorRerates(ICON, NsfwLevel.X);

    expect(ratingOf('apl_a')).toBe('x');
  });
});

describe('which listings are touched', () => {
  it.each([
    ['a shadow revision', { status: 'draft', revisionOfId: 'apl_parent' }],
    ['an approved-status shadow', { status: 'approved', revisionOfId: 'apl_parent' }],
    ['a draft', { status: 'draft' }],
    ['a pending listing', { status: 'pending' }],
    ['a removed listing', { status: 'removed' }],
  ])('leaves %s alone, in both directions', async (_label, state) => {
    seedMisScanned(state as Partial<Listing>);
    await moderatorRerates(SHOT, NsfwLevel.PG);
    expect(ratingOf('apl_a')).toBe('r');

    await moderatorRerates(ICON, NsfwLevel.X);
    expect(ratingOf('apl_a')).toBe('r');
    expect(events).toEqual([]);
    expect(bustCatalog).not.toHaveBeenCalled();
    // Not even locked: the lookup is what keeps non-live rows out of a transaction.
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('an image used by two listings moves both, each by its own rule', async () => {
    listings.push({
      id: 'apl_b',
      slug: 'app-b',
      kind: 'onsite',
      status: 'approved',
      revisionOfId: null,
      contentRating: 'r',
      iconId: SHOT,
      coverId: null,
      declared: 'pg',
    });

    const changed = await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('pg13');
    expect(ratingOf('apl_b')).toBe('pg');
    expect(changed.map((c) => c.appListingId)).toEqual(['apl_a', 'apl_b']);
    expect(events.map((e) => [e.appListingId, e.slug])).toEqual([
      ['apl_a', 'app-a'],
      ['apl_b', 'app-b'],
    ]);
    expect(bustCatalog).toHaveBeenCalledTimes(1);
  });

  it('an image in two slots of one listing is one asset', async () => {
    seedMisScanned({ contentRating: 'pg13', iconId: SHOT, coverId: SHOT });
    images.find((i) => i.id === SHOT)!.nsfwLevel = NsfwLevel.PG13;

    await moderatorRerates(SHOT, NsfwLevel.X);

    expect(ratingOf('apl_a')).toBe('x');
    expect(ops.filter((o) => o === 'tx:update')).toHaveLength(1);
    expect(events.map((e) => e.after)).toEqual([{ contentRating: 'x' }]);
  });

  it.each([
    ['icon', { iconId: 77 }],
    ['cover', { coverId: 77 }],
  ])('finds a listing that uses the image as its %s', async (_slot, slot) => {
    seedMisScanned({ contentRating: 'pg13', ...slot });
    images.push({ id: 77, nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' });

    await moderatorRerates(77, NsfwLevel.X);

    expect(ratingOf('apl_a')).toBe('x');
  });

  it('an image no listing uses is a no-op: no transaction, no event, no cache bust', async () => {
    images.push({ id: 404, nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned' });

    const changed = await moderatorRerates(404, NsfwLevel.X);

    expect(changed).toEqual([]);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(bustCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ['left `approved`', { status: 'pending' }],
    ['is a shadow revision', { revisionOfId: 'apl_parent' }],
  ])('a listing that %s by the time it is locked is left alone', async (_label, state) => {
    Object.assign(listings[0], state);
    images.find((i) => i.id === ICON)!.nsfwLevel = NsfwLevel.X;

    const result = await reDeriveListingRatingInTx(directTx(), {
      appListingId: 'apl_a',
      imageId: ICON,
      previousNsfwLevel: NsfwLevel.PG,
      actorUserId: MOD,
    });

    expect(result).toBeNull();
    expect(ratingOf('apl_a')).toBe('r');
  });

  it('a listing the image was detached from between the lookup and the lock is left alone', async () => {
    // Declared above stored, so there IS a raise pending — just not this image's to make.
    seedMisScanned({ declared: 'x' });
    shots = [];

    const result = await reDeriveListingRatingInTx(directTx(), {
      appListingId: 'apl_a',
      imageId: SHOT,
      previousNsfwLevel: NsfwLevel.R,
      actorUserId: MOD,
    });

    expect(result).toBeNull();
    expect(ratingOf('apl_a')).toBe('r');
  });

  it('a lowering runs lock → reads → write → history, all inside the transaction', async () => {
    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ops).toEqual([
      'pool:lookup',
      // The civitai.red-override lookup's probe (`listListingIdsWithRedSlotImage`), on the pool.
      'pool:split',
      'tx:lock',
      'tx:listing',
      'tx:listing',
      'tx:shots',
      // The overrides read under the lock (`loadListingRatingAssets`), inside the transaction.
      'tx:split',
      'tx:images',
      'tx:reviewed',
      'tx:split',
      'tx:update',
      'tx:event',
    ]);
  });

  it('a raise writes its history on the pool, after the transaction', async () => {
    await moderatorRerates(ICON, NsfwLevel.X);

    expect(ops.slice(-2)).toEqual(['tx:update', 'pool:event']);
  });

  it('the lock statement names the live row and nothing else', async () => {
    await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(lockStatements).toEqual([
      `SELECT "id" FROM "app_listings" WHERE "id" = $1 AND "status" = 'approved' AND "revision_of_id" IS NULL FOR UPDATE`,
    ]);
  });
});

describe('a listing a moderator split (civitai.red-only mature media)', () => {
  /** Declared g, stored g, every asset PG — then one of them is re-rated. */
  function seedSfw() {
    seedMisScanned({ contentRating: 'g' });
    for (const i of images) i.nsfwLevel = NsfwLevel.PG;
  }

  it('🔴 a screenshot re-rated PG → R leaves a split listing at its rating', async () => {
    seedSfw();
    splitListings.add('apl_a');

    const changed = await moderatorRerates(SHOT, NsfwLevel.R);

    expect(ratingOf('apl_a')).toBe('g');
    expect(changed).toEqual([]);
    expect(events).toEqual([]);
  });

  it('🔴 so does the icon re-rated PG → R: the listing stays on civitai.com', async () => {
    seedSfw();
    splitListings.add('apl_a');

    await moderatorRerates(ICON, NsfwLevel.R);

    expect(ratingOf('apl_a')).toBe('g');
  });

  it('invariant guard: without the split the same re-rate still raises the listing', async () => {
    seedSfw();

    const changed = await moderatorRerates(SHOT, NsfwLevel.R);

    expect(ratingOf('apl_a')).toBe('r');
    expect(changed).toEqual([{ appListingId: 'apl_a', before: 'g', after: 'r' }]);
  });

  it('a split still raises for a re-rate that stays within SFW', async () => {
    seedSfw();
    splitListings.add('apl_a');

    await moderatorRerates(SHOT, NsfwLevel.PG13);

    expect(ratingOf('apl_a')).toBe('pg13');
  });

  it('the split is read per listing: a sibling sharing the image is raised', async () => {
    seedSfw();
    listings.push({ ...listings[0], id: 'apl_b', slug: 'app-b' });
    shots.push({ appListingId: 'apl_b', imageId: SHOT });
    splitListings.add('apl_a');

    await moderatorRerates(SHOT, NsfwLevel.R);

    expect(ratingOf('apl_a')).toBe('g');
    expect(ratingOf('apl_b')).toBe('r');
  });
});

describe('failure isolation', () => {
  it('a RAISE survives a rejected history insert: the rating moves, the event is missing', async () => {
    failEventInsert = true;

    const changed = await moderatorRerates(ICON, NsfwLevel.X);

    expect(ratingOf('apl_a')).toBe('x');
    expect(changed).toEqual([{ appListingId: 'apl_a', before: 'r', after: 'x' }]);
    expect(events).toEqual([]);
    expect(bustCatalog).toHaveBeenCalledTimes(1);
    // The warning is the only trace that the history row is missing.
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      `[listing-rating] re-derive after image ${ICON} was re-rated failed (listing apl_a): violates check constraint`
    );
  });

  it('a failed cache bust does not throw', async () => {
    bustCatalog.mockRejectedValueOnce(new Error('cache bus down'));

    await expect(moderatorRerates(SHOT, NsfwLevel.PG)).resolves.toHaveLength(1);
  });

  it('a LOWERING with a rejected history insert rolls the rating back and does not throw', async () => {
    failEventInsert = true;

    const changed = await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(changed).toEqual([]);
    expect(ratingOf('apl_a')).toBe('r');
    expect(events).toEqual([]);
    expect(bustCatalog).not.toHaveBeenCalled();
  });

  it('one listing failing does not stop the next', async () => {
    listings.push({
      id: 'apl_b',
      slug: 'app-b',
      kind: 'onsite',
      status: 'approved',
      revisionOfId: null,
      contentRating: 'r',
      iconId: SHOT,
      coverId: null,
      declared: 'g',
    });
    failUpdateFor = 'apl_a';

    const changed = await moderatorRerates(SHOT, NsfwLevel.PG);

    expect(ratingOf('apl_a')).toBe('r');
    expect(ratingOf('apl_b')).toBe('g');
    expect(changed).toEqual([{ appListingId: 'apl_b', before: 'r', after: 'g' }]);
  });

  it('a failed lookup does not throw', async () => {
    (dbMock.dbWrite.appListing.findMany as unknown as Fn).mockImplementation((async () => {
      throw new Error('connection refused');
    }) as never);

    await expect(moderatorRerates(SHOT, NsfwLevel.PG)).resolves.toEqual([]);
    expect(ratingOf('apl_a')).toBe('r');
  });
});
