import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatureRatingsAllowed } from '~/server/services/blocks/app-listing-store-gate';
import {
  matureRatingAllowed,
  matureRatingsAllowed,
} from '~/server/services/blocks/app-listing-store-gate';
import {
  listingMatureFilter,
  subListingMatureFilter,
} from '~/server/services/blocks/app-listing.service';

/**
 * The store's maturity gate, run in Postgres: `listingMatureFilter` (apps) and
 * `subListingMatureFilter` (item cards) against rows of every rating. An `xxx` app or item is shown
 * only to a viewer whose browsing level includes XXX, on a red (mature-capable) host, the same as
 * `x`; and each SQL filter keeps exactly the rows its JS twin `matureRatingAllowed` admits.
 *
 * Levels are NsfwLevel bits: PG 1, PG-13 2, R 4, X 8, XXX 16.
 */

// Distinct spellings, so a filter that compares without LOWER or with a trim shows up.
const RATINGS: Array<string | null> = [
  'g',
  'pg',
  'pg13',
  'r',
  'R',
  'x',
  'X',
  'xxx',
  'XXX',
  ' xxx ',
  'unrated',
  '',
  null,
];

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE app_listings (id int PRIMARY KEY, content_rating text);
    CREATE TABLE app_sub_listings (id int PRIMARY KEY, content_rating text);
  `);
  for (const [i, rating] of RATINGS.entries()) {
    await db.query('INSERT INTO app_listings (id, content_rating) VALUES ($1, $2)', [i, rating]);
    await db.query('INSERT INTO app_sub_listings (id, content_rating) VALUES ($1, $2)', [
      i,
      rating,
    ]);
  }
});
afterAll(() => db.close());

const run = async (table: string, alias: string, filter: Prisma.Sql) => {
  const { rows } = await db.query<{ id: number }>(
    `SELECT ${alias}.id FROM ${table} ${alias} WHERE ${filter.text} ORDER BY ${alias}.id`,
    filter.values as unknown[]
  );
  return rows.map((r) => RATINGS[r.id]);
};
/** The app ratings the store shows `allowed`. */
const apps = (allowed: MatureRatingsAllowed) =>
  run('app_listings', 'al', listingMatureFilter(allowed));
/** The item-card ratings the store shows `allowed`. */
const items = (allowed: MatureRatingsAllowed) =>
  run('app_sub_listings', 's', subListingMatureFilter(allowed));

const RED = true;
const GREEN = false;
const RX = 1 | 2 | 4 | 8;
const RX_XXX = RX | 16;

describe('🔴 the store shows xxx only to a viewer whose level includes XXX, on a red host', () => {
  // Only the four ratings that decide the case; the twin test below covers every rating.
  const decisive = (shown: Array<string | null>) =>
    shown.filter((r) => r === 'g' || r === 'x' || r === 'xxx' || r === 'XXX');

  it.each<[string, boolean, number, string[]]>([
    ['R+X without XXX, red host', RED, RX, ['g', 'x']],
    ['R+X+XXX, red host', RED, RX_XXX, ['g', 'x', 'xxx', 'XXX']],
    ['XXX without X, red host', RED, 1 | 2 | 16, ['g', 'xxx', 'XXX']],
    ['R+X+XXX, green host', GREEN, RX_XXX, ['g']],
  ])('%s: apps and item cards shown = %j', async (_, redCapable, level, shown) => {
    const allowed = matureRatingsAllowed(redCapable, level);
    expect(decisive(await apps(allowed))).toEqual(shown);
    expect(decisive(await items(allowed))).toEqual(shown);
  });
});

describe('🔴 each SQL filter keeps exactly the rows matureRatingAllowed admits', () => {
  const ALL_ALLOWED: MatureRatingsAllowed[] = [];
  for (const r of [false, true])
    for (const x of [false, true]) for (const xxx of [false, true]) ALL_ALLOWED.push({ r, x, xxx });

  it.each(ALL_ALLOWED)('allowed %j', async (allowed) => {
    const expected = RATINGS.filter((rating) => matureRatingAllowed(rating, allowed));
    expect(await apps(allowed)).toEqual(expected);
    expect(await items(allowed)).toEqual(expected);
  });

  it('positive control: the eight allowed sets do not all show the same rows', async () => {
    const shown = new Set<string>();
    for (const allowed of ALL_ALLOWED) shown.add(JSON.stringify(await apps(allowed)));
    expect(shown.size).toBe(8);
  });
});
