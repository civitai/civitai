// Generates the reference vectors (testdata/golden/vectors.json) content-policy-go's tests read.
// Run from the repo root:
//
//   pnpm exec tsx --tsconfig tsconfig.json apps/content-policy-go/testdata/golden/gen.ts
//
// scripts/__tests__/content-policy-go-vectors.schema-drift.test.ts regenerates them in CI and fails
// when the committed file differs, so a change to any function below that changes an answer must
// regenerate this file, and the Go tests then say whether the port still agrees.
//
// Everything here is SYNTHETIC: hosts under .invalid, invented region lists (CONFIG), invented user
// settings. No production data.
//
// Where an expected value comes from: the REAL Node code, each caller context through the functions
// that caller calls today:
//   - registry-subscription: getRegion, describeRegion, normalizeRegion, countryKnown
//     (request-origin.ts), isRegionBlocked / isRegionRestricted (region-blocking.ts),
//     audienceForUser, ANONYMOUS_AUDIENCE and audienceAdmits (audience.ts).
//   - site: getFeatureFlags(...).canViewNsfw (feature-flags.service.ts), getServerBrowsingLevel,
//     isRedCapableHost (server-domain.ts), matureRatingsAllowed / matureRatingAllowed
//     (app-listing-store-gate.ts), isRegionRestricted / isRegionBlocked.
//   - public-api: apiBrowsingLevel (browsing-level.ts), isAPIAccessBlocked (region-blocking.ts),
//     matureRatingsAllowed / matureRatingAllowed.
// The site and API read the wall clock (`new Date()`), so each of their vectors runs with
// `new Date()` answering its `at` (withClock).
//
// What this file DERIVES itself, composing the real functions' answers (no Node function returns
// these as such; each is checked or explained where it is computed):
//   - every `reason` (the service's metric label; DESIGN.md defines it);
//   - the registry's `regionHold` split into blocked vs restricted: describeRegion answers only
//     held or not, so the split is isRegionBlocked / isRegionRestricted on the same normalised
//     region, checked against describeRegion's `restricted` (a mismatch throws);
//   - the registry's `browsingLevel`: getServerBrowsingLevel with canViewNsfw = not held, the call
//     audienceForUser makes (an Audience does not keep the level);
//   - the site's `regionHold`: restricted unless the user is a moderator (the feature-flag
//     service's bypass), from isRegionRestricted;
//   - the site's and API's blocked answer: refused (no ratings, level 0), from isRegionBlocked /
//     isAPIAccessBlocked, standing for the site's block page and the API's 451, which serve nothing.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = join(__dirname);
export const CONTENT_POLICY_VECTORS_PATH = join(HERE, 'vectors.json');

/** The region lists every vector is decided under (the env the site and adapter read them from). */
export const CONFIG = {
  // FR from the end of 2025-08-01; every US request with no region (or one with `us` as its country);
  // US:NY; a lowercase entry, uppercased on read; DE not yet in force.
  REGION_RESTRICTION_CONFIG:
    'FR:2025-08-01,US:2025-06-01,US:NY:2025-07-24, us:tx:2025-01-01 ,DE:2030-01-01',
  // GB and AU (the defaults' dates), and US:UT not yet in force.
  REGION_BLOCK_CONFIG: 'GB:2025-07-24,AU:2026-03-15,US:UT:2026-12-01',
};

const HOSTS = {
  green: 'green.content-policy.invalid',
  blue: 'blue.content-policy.invalid',
  red: 'red.content-policy.invalid',
  other: 'other.content-policy.invalid',
} as const;
type HostColor = keyof typeof HOSTS;

const CONTEXTS = ['registry-subscription', 'site', 'public-api'] as const;
type Context = (typeof CONTEXTS)[number];

/** Every rating a decision answers for, as the service orders them: the ladder, then xxx. */
const RATINGS = ['g', 'pg', 'pg13', 'r', 'x', 'xxx'];
/** Ratings outside the ladder; each must be answered the same (`unknownRating`). */
const UNKNOWN_RATINGS = [null, undefined, '', 'nc17', 'unrated'];

type UserSettings = { showNsfw: boolean; browsingLevel: number; isModerator: boolean };
type Loc = { country: string | null; region: string | null; isUk: string | null };
type Want = {
  ratings: string[];
  unknownRating: boolean;
  browsingLevel: number;
  regionHold: 'none' | 'restricted' | 'blocked';
  reason: string;
};
export type Vector = Loc & {
  context: Context;
  host: HostColor | null;
  user: string | null;
  at: string;
  want: Want;
};

// Every level class: 0 (unset), PG, SFW, single mature bits, mixes, all, Blocked alone and with
// everything, and a negative value (the column is a plain int4).
const LEVELS = [0, 1, 3, 4, 7, 8, 12, 15, 16, 28, 31, 32, 63, -1];
export const USERS: Record<string, UserSettings> = {};
for (const showNsfw of [false, true])
  for (const browsingLevel of LEVELS)
    for (const isModerator of [false, true])
      USERS[`s${+showNsfw}-l${browsingLevel}-m${+isModerator}`] = {
        showNsfw,
        browsingLevel,
        isModerator,
      };

const loc = (country: string | null, region: string | null = null, isUk: string | null = null) => ({
  country,
  region,
  isUk,
});

/** The edge values, one per class the rules distinguish. */
const REGION_CASES: Loc[] = [
  loc('NL'), // a known country no list names
  loc('FR'), // restricted
  loc('fr'), // lowercase: uppercased before the list is read
  loc(' FR'), // a space: the adapter trims it (known), the lists are read untrimmed (no match)
  loc('FR '),
  loc('\u00a0FR'), // JS trims NBSP and BOM, not NEL
  loc('\ufeffFR'),
  loc('\u0085FR'),
  loc('gb\n'),
  loc(' GB'), // a blocked country padded: the adapter holds it (normalizeRegion), the site does not
  loc('GB'), // blocked
  loc('gb'),
  loc('GB', 'ENG'), // a region beside a non-US country is ignored
  loc('AU'), // blocked since 2026-03-15
  loc('DE'), // restricted from 2030
  loc('US'), // US with no region: judged as US
  loc('US', 'NY'),
  loc('US', 'ny'),
  loc('us', 'NY'), // `us` is not `US`: judged by the country alone
  loc('us', 'CA'),
  loc('US', 'CA'), // a state no list names, though US itself is listed
  loc('US', 'TX'), // listed lowercase
  loc('US', 'UT'), // blocked from 2026-12-01
  loc('US', ''), // an empty region is no region
  loc('US', ' NY'),
  loc('us', ' ny '), // lowercased and padded: the adapter judges US:NY, the site judges US
  loc(null), // no country header
  loc(''),
  loc('XX'), // the edge's "unknown"
  loc('xx'),
  loc('T1'), // Tor
  loc('t1'),
  loc('USA'), // not two letters
  loc('G'),
  loc('1A'),
  loc('ZZ'), // two letters, no list: known
  loc('ß'), // JS uppercases it to SS (two letters)
  loc('ſe'), // ... and this to SE
  loc('ﬀ'), // ... and this to FF
  loc(null, null, 'true'), // x-isuk makes it GB
  loc('FR', null, '1'),
  loc('FR', null, 'false'),
  loc('FR', null, 'TRUE'),
  loc('FR', null, 'yes'),
  loc('US', 'NY', '1'),
  loc('', null, '1'),
];

/** A fixed instant after every rule in force here except DE's and US:UT's. */
const AT0 = '2026-11-19T12:00:00.000Z';
/** Around the end of a rule's date: before the day, its last two milliseconds, the next day. */
const boundary = (date: string) => [
  `${date}T00:00:00.000Z`,
  `${date}T23:59:59.998Z`,
  `${date}T23:59:59.999Z`,
  `${nextDay(date)}T00:00:00.000Z`,
];
const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

type Case = Omit<Vector, 'want'>;

function cases(): Case[] {
  const out: Case[] = [];
  const allUsers = [null, ...Object.keys(USERS)];
  const sample = [null, 's1-l31-m0', 's1-l31-m1', 's1-l3-m0'];
  const hosts: (HostColor | null)[] = [null, 'green', 'blue', 'red', 'other'];
  const fixedRegions = [loc('NL'), loc('FR'), loc('GB'), loc(null)];
  // A: who is asking, from where (host), in each context, over the four region classes.
  for (const l of fixedRegions) {
    for (const user of allUsers) {
      for (const host of hosts) out.push({ ...l, context: 'site', host, user, at: AT0 });
      for (const host of [null, 'red'] as const)
        out.push({ ...l, context: 'registry-subscription', host, user, at: AT0 });
    }
    for (const user of [null, 's1-l31-m0', 's0-l1-m0'])
      out.push({ ...l, context: 'public-api', host: null, user, at: AT0 });
  }
  // B: every region class, in every context.
  for (const l of REGION_CASES)
    for (const context of CONTEXTS)
      for (const user of sample) out.push({ ...l, context, host: 'red', user, at: AT0 });
  // C: the dated rules either side of the end of their date.
  for (const [l, date] of [
    [loc('FR'), '2025-08-01'],
    [loc('AU'), '2026-03-15'],
  ] as const)
    for (const at of boundary(date))
      for (const context of CONTEXTS)
        for (const user of sample) out.push({ ...l, context, host: 'red', user, at });
  return out;
}

/**
 * Runs `fn` with `new Date()` answering `at` and every `Date.now()` a day after the last, so the
 * site's feature cache (keyed on user, host and region, not on time) never answers one vector with
 * another's result.
 */
let tick = Date.parse('2100-01-01T00:00:00.000Z');
function withClock<T>(at: string, fn: () => T): T {
  const Real = Date;
  const fixed = Real.parse(at);
  class Clock extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string]));
    }
    static now() {
      tick += 86_400_000;
      return tick;
    }
  }
  globalThis.Date = Clock as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = Real;
  }
}

const REFUSED: Omit<Want, 'reason' | 'regionHold'> = {
  ratings: [],
  unknownRating: false,
  browsingLevel: 0,
};

/**
 * Builds every vector from the real Node code. Sets the region lists and hosts in `process.env`
 * BEFORE importing the modules that read them at load; a caller that already imported them with
 * other values must reset its module registry first (the drift test does), or this throws.
 */
export async function buildVectors() {
  process.env.REGION_RESTRICTION_CONFIG = CONFIG.REGION_RESTRICTION_CONFIG;
  process.env.REGION_BLOCK_CONFIG = CONFIG.REGION_BLOCK_CONFIG;
  process.env.SERVER_DOMAIN_GREEN = HOSTS.green;
  process.env.SERVER_DOMAIN_BLUE = HOSTS.blue;
  process.env.SERVER_DOMAIN_RED = HOSTS.red;
  for (const c of ['GREEN', 'BLUE', 'RED']) delete process.env[`SERVER_DOMAIN_${c}_ALIASES`];
  delete process.env.REGISTRY_ADAPTER_TRUST_META;
  delete process.env.DEV_REGION_OVERRIDE;
  // isDev changes getRegion (a missing country becomes US:CA) and skips the feature region check.
  if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV)
    process.env.NODE_ENV = 'test';

  const rb = await import('~/server/utils/region-blocking');
  const origin = await import('~/server/registry-adapter/request-origin');
  const audience = await import('~/server/registry-adapter/audience');
  const level = await import('~/server/utils/browsing-level');
  const gate = await import('~/server/services/blocks/app-listing-store-gate');
  const domain = await import('~/server/utils/server-domain');
  const features = await import('~/server/services/feature-flags.service');
  const { sfwBrowsingLevelsFlag } = await import('~/shared/constants/browsingLevel.constants');

  // The lists must be the ones set above, or every expected value is about another policy.
  const listed = (l: { region: string; effectiveDate: string }[]) =>
    l.map((c) => `${c.region}:${c.effectiveDate}`).join(',');
  const want = (env: string) =>
    env
      .split(',')
      .map((s) => s.trim())
      .map((s) => s.slice(0, s.lastIndexOf(':')).toUpperCase() + s.slice(s.lastIndexOf(':')))
      .join(',');
  if (
    listed(rb.REGION_RESTRICTION_CONFIG) !== want(CONFIG.REGION_RESTRICTION_CONFIG) ||
    listed(rb.REGION_BLOCK_CONFIG) !== want(CONFIG.REGION_BLOCK_CONFIG)
  )
    throw new Error('region-blocking was loaded with other region lists; reset modules first');
  if (!domain.isRedCapableHost(HOSTS.red) || domain.isRedCapableHost(HOSTS.blue))
    throw new Error('server-domain was loaded with other hosts; reset modules first');

  const sameForUnknown = (admit: (rating: string | null | undefined) => boolean) => {
    const answers = new Set(UNKNOWN_RATINGS.map(admit));
    if (answers.size !== 1) throw new Error('ratings outside the ladder were answered differently');
    return [...answers][0];
  };

  function decide(c: Case): Want {
    const settings = c.user === null ? null : USERS[c.user];
    const headers: Record<string, string> = {};
    if (c.country !== null) headers['cf-ipcountry'] = c.country;
    if (c.region !== null) headers['cf-region-code'] = c.region;
    if (c.isUk !== null) headers['x-isuk'] = c.isUk;
    const at = new Date(c.at);
    const region = rb.getRegion({ headers } as never);
    const blocked = rb.isRegionBlocked(region, at);
    const restricted = rb.isRegionRestricted(region, at);

    if (c.context === 'registry-subscription') {
      const held = origin.describeRegion({ headers }, at).restricted;
      // The adapter judges the region normalised (normalizeRegion), so the split is made on it too.
      const normal = origin.normalizeRegion(region);
      const known = origin.countryKnown(normal);
      const regBlocked = rb.isRegionBlocked(normal, at);
      const regRestricted = rb.isRegionRestricted(normal, at);
      const [regionHold, regionReason] = !known
        ? (['restricted', 'unknown-country'] as const)
        : regBlocked
        ? (['blocked', 'region-blocked'] as const)
        : regRestricted
        ? (['restricted', 'region-restricted'] as const)
        : (['none', null] as const);
      if (held !== (regionHold !== 'none'))
        throw new Error(`hold mismatch for ${JSON.stringify(c)}`);
      const aud = settings
        ? audience.audienceForUser(settings, { regionRestricted: held })
        : audience.ANONYMOUS_AUDIENCE;
      const browsingLevel = settings
        ? level.getServerBrowsingLevel({ canViewNsfw: !held, user: settings })
        : level.getServerBrowsingLevel({ canViewNsfw: true, user: null });
      return {
        ratings: RATINGS.filter((r) => audience.audienceAdmits(aud, r)),
        unknownRating: sameForUnknown((r) => audience.audienceAdmits(aud, r)),
        browsingLevel,
        regionHold,
        reason: regionReason ?? (settings ? 'user-settings' : 'anonymous'),
      };
    }

    if (c.context === 'site') {
      const host = c.host === null ? undefined : HOSTS[c.host];
      const user = settings
        ? ({ id: 1001, permissions: [], ...settings } as unknown as Parameters<
            typeof features.getFeatureFlags
          >[0]['user'])
        : undefined;
      const req = { headers: host ? { ...headers, host } : headers };
      const canViewNsfw = withClock(
        c.at,
        () => !!features.getFeatureFlags({ user, host, req: req as never }).canViewNsfw
      );
      if (blocked) return { ...REFUSED, regionHold: 'blocked', reason: 'region-blocked' };
      const browsingLevel = level.getServerBrowsingLevel({ canViewNsfw, user: settings });
      const allowed = gate.matureRatingsAllowed(domain.isRedCapableHost(host), browsingLevel);
      const mod = !!settings?.isModerator;
      const held = restricted && !mod;
      return {
        ratings: RATINGS.filter((r) => gate.matureRatingAllowed(r, allowed)),
        unknownRating: sameForUnknown((r) => gate.matureRatingAllowed(r, allowed)),
        browsingLevel,
        regionHold: held ? 'restricted' : 'none',
        reason: held
          ? 'region-restricted'
          : restricted
          ? 'moderator-bypass'
          : !canViewNsfw
          ? 'host-sfw'
          : settings
          ? 'user-settings'
          : 'anonymous',
      };
    }

    // public-api
    const req = { headers };
    const refused = withClock(c.at, () => rb.isAPIAccessBlocked(rb.getRegion(req as never)));
    if (refused) return { ...REFUSED, regionHold: 'blocked', reason: 'region-blocked' };
    const browsingLevel = withClock(c.at, () => level.apiBrowsingLevel(req as never));
    const held = browsingLevel === sfwBrowsingLevelsFlag;
    const allowed = gate.matureRatingsAllowed(true, browsingLevel);
    return {
      ratings: RATINGS.filter((r) => gate.matureRatingAllowed(r, allowed)),
      unknownRating: sameForUnknown((r) => gate.matureRatingAllowed(r, allowed)),
      browsingLevel,
      regionHold: held ? 'restricted' : 'none',
      reason: held ? 'region-restricted' : 'unrestricted',
    };
  }

  const vectors: Vector[] = cases().map((c) => ({ ...c, want: decide(c) }));
  return {
    $comment:
      'Generated by apps/content-policy-go/testdata/golden/gen.ts from the real Node code; do not edit. Regenerate: pnpm exec tsx --tsconfig tsconfig.json apps/content-policy-go/testdata/golden/gen.ts',
    config: CONFIG,
    users: USERS,
    vectors,
  };
}

/** The file: the header fields pretty-printed, one vector per line so a diff names the vector. */
export async function renderVectors() {
  const { vectors, ...head } = await buildVectors();
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${top},\n  "vectors": [\n${vectors
    .map((v) => `    ${JSON.stringify(v)}`)
    .join(',\n')}\n  ]\n}\n`;
}

if (process.argv[1]?.endsWith('gen.ts')) {
  renderVectors().then(
    (text) => {
      writeFileSync(CONTENT_POLICY_VECTORS_PATH, text);
      console.log(`wrote ${CONTENT_POLICY_VECTORS_PATH}`);
      process.exit(0);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
