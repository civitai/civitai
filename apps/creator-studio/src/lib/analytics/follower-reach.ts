// Shared (server + browser) shapes and pure helpers for the follower-reach panels. The queries live in
// `$lib/server/follower-reach`; everything here is safe to import from a component.

// Leaf module, not the chart barrel: the barrel re-exports `chart.svelte`, and this file is imported by the
// plain-node test project, which has no Svelte plugin — through the barrel the suite collects zero tests.
import { CHART_PALETTE_SIZE } from '@civitai/ui/components/ui/chart/chart-colors.js';

export type ReachWindow = 30 | 60 | 100;
export const REACH_WINDOWS: ReachWindow[] = [30, 60, 100];

export function emptyWindows(): Record<ReachWindow, number> {
  return Object.fromEntries(REACH_WINDOWS.map((d) => [d, 0])) as Record<ReachWindow, number>;
}

export type CountrySlice = {
  /** ISO 3166-1 alpha-2, or '' for followers we have no country for. */
  code: string;
  followers: number;
};

export type CountryBreakdown = {
  /** Named countries, largest first, at most `MAX_COUNTRY_SLICES` of them. */
  slices: CountrySlice[];
  /** Countries below the per-country floor or past the slice cap, summed. */
  other: number;
  /**
   * Followers with no country on record — no tracked pageview since `pageViews` begins (2024-09-26).
   * Kept separate from `other` rather than folded into it: "other countries" says we know where they are
   * and chose not to name it, which is a different claim. (86.2% had a country — 15k sample, 2026-09-04.)
   */
  unknown: number;
};

/**
 * The per-country counts exactly as ClickHouse returned them — every country, including ones holding a
 * single follower. This shape must NOT reach a page: see `MIN_FOLLOWERS_PER_COUNTRY`.
 */
export type FollowerReachRaw = {
  followers: number;
  active: Record<ReachWindow, number>;
  countries: CountrySlice[];
};

/** What a page may hold: the long tail already collapsed into `other`. */
export type FollowerReach = {
  followers: number;
  /** Followers with any tracked activity inside each window. Nested: `active[30] <= active[60] <= active[100]`. */
  active: Record<ReachWindow, number>;
  countries: CountryBreakdown;
};

/** One ClickHouse row: a country, how many of the probed followers sit in it, and how many were active. */
export type ReachRow = {
  country: string;
  followers: number;
  active: Record<ReachWindow, number>;
};

export function mergeReachChunks(chunks: ReachRow[][], followers: number): FollowerReachRaw {
  const byCountry = new Map<string, number>();
  const active = emptyWindows();
  for (const rows of chunks) {
    for (const row of rows) {
      byCountry.set(row.country, (byCountry.get(row.country) ?? 0) + row.followers);
      for (const d of REACH_WINDOWS) active[d] += row.active[d];
    }
  }

  // A follower with no row in the rollup at all is not missing data to be dropped — they have no tracked
  // activity since the rollup's sources begin, which is exactly what "dormant, country unknown" means. Folding
  // them into the '' bucket is what makes the country slices sum to the follower count the rest of the page
  // shows.
  const accountedFor = [...byCountry.values()].reduce((sum, n) => sum + n, 0);
  if (accountedFor < followers) {
    byCountry.set('', (byCountry.get('') ?? 0) + (followers - accountedFor));
  }

  return {
    followers,
    active,
    countries: [...byCountry].map(([code, count]) => ({ code, followers: count })),
  };
}

// Below this the panels are suppressed entirely. Two reasons, and the privacy one is the binding one:
// a country breakdown over a handful of followers names where an individual follower lives, and an
// "active in the last 30 days" percentage over the same set says whether that person was online.
export const MIN_FOLLOWERS_FOR_REACH = 25;

// A country holding fewer than this many of a creator's followers is folded into "Other" rather than
// listed. Same reasoning one level down: the suppression above protects small creators, this protects
// the long tail of every creator — a single follower in a small country is otherwise named outright.
export const MIN_FOLLOWERS_PER_COUNTRY = 5;

// `chartColor` wraps at the palette size, so one more named country than there are colors draws two arcs
// the same blue — which reads as a rendering bug. The overflow lands in "Other countries".
export const MAX_COUNTRY_SLICES = CHART_PALETTE_SIZE;

export function buildCountryBreakdown(countries: CountrySlice[]): CountryBreakdown {
  const named = countries.filter((c) => c.code !== '');
  const slices = named
    .filter((c) => c.followers >= MIN_FOLLOWERS_PER_COUNTRY)
    .sort((a, b) => b.followers - a.followers)
    .slice(0, MAX_COUNTRY_SLICES);
  const shown = new Set(slices.map((c) => c.code));

  return {
    slices,
    other: named.filter((c) => !shown.has(c.code)).reduce((sum, c) => sum + c.followers, 0),
    unknown: countries.find((c) => c.code === '')?.followers ?? 0,
  };
}

/**
 * SvelteKit serialises the whole load return into `__sveltekit_data` and `__data.json`, so a component-side
 * filter is not enforcement — it still publishes "one follower in NO" to View Source. Hence server-side.
 */
export function redactReach(raw: FollowerReachRaw): FollowerReach {
  return {
    followers: raw.followers,
    active: raw.active,
    countries: buildCountryBreakdown(raw.countries),
  };
}

/**
 * `suppressed` and `unavailable` both render no panel, and they must stay distinct anyway: one is a
 * deliberate withholding, the other an outage that should say so rather than pass for a complete page.
 * `suppressed` carries no `reach`, so the withheld numbers never reach the payload.
 */
export type FollowerReachResult =
  { status: 'ok'; reach: FollowerReach } | { status: 'suppressed' } | { status: 'unavailable' };

export function presentReach(reach: FollowerReach): FollowerReachResult {
  return reach.followers >= MIN_FOLLOWERS_FOR_REACH
    ? { status: 'ok', reach }
    : { status: 'suppressed' };
}

const regionNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : undefined;

export function countryName(code: string): string {
  if (!code) return 'Unknown';
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    // `of` throws on anything that isn't a well-formed region code. Geo lookup can emit values that
    // aren't ISO regions (Cloudflare uses 'T1' for Tor and 'XX' for unknown), so show the raw code.
    return code;
  }
}
