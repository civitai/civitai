import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRumGeoAttributes,
  GEO_REGION_ATTR,
  GEO_TIMEZONE_ATTR,
  GEO_UNKNOWN_VALUE,
} from '~/utils/faro/geoAttributes';
import { buildRumExperimentAttributes } from '~/utils/faro/experimentFlags';

/**
 * Tests the RUM geo-attributes mechanism. `buildRumGeoAttributes` is the load-bearing pure
 * function: FaroProvider calls it with the SSR-derived country code and merges its output
 * VERBATIM into `initializeFaro`'s `sessionTracking.session.attributes` — so testing this
 * output IS testing the attributes that get set on the session at init (which then ride on
 * `meta.session.attributes` → Loki `session_attr_region` / `session_attr_timezone` of every
 * beacon).
 *
 * The ALWAYS-SET rule is the headline contract: an absent attribute falls out of Loki's
 * `| logfmt | by (region)` grouping entirely, so both keys must be present on EVERY output —
 * absence must be the value `unknown`, never a missing key.
 */

const setWindow = (present: boolean) => {
  if (present) {
    (globalThis as unknown as { window: unknown }).window = { location: { origin: 'https://x' } };
  } else {
    delete (globalThis as unknown as { window?: unknown }).window;
  }
};

/** Pin `Intl.DateTimeFormat().resolvedOptions().timeZone` to a deterministic IANA zone. */
const mockTimeZone = (zone: string | (() => never)) => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
    if (typeof zone === 'function') throw new Error('Intl unavailable');
    return { resolvedOptions: () => ({ timeZone: zone }) } as Intl.DateTimeFormat;
  });
};

afterEach(() => {
  setWindow(false);
  vi.restoreAllMocks();
});

describe('buildRumGeoAttributes — the always-set rule', () => {
  it.each([null, undefined, '', '   '])('maps %p to the `unknown` region value', (input) => {
    setWindow(false);
    const attrs = buildRumGeoAttributes(input as string | null | undefined);
    expect(attrs[GEO_REGION_ATTR]).toBe(GEO_UNKNOWN_VALUE);
  });

  it('ALWAYS emits both keys — even for a null country code (absence must be a value, not a missing Loki field)', () => {
    setWindow(false);
    const attrs = buildRumGeoAttributes(null);
    expect(Object.keys(attrs).sort()).toEqual([GEO_REGION_ATTR, GEO_TIMEZONE_ATTR].sort());
  });

  it('emits both keys for a valid country code too (no conditional emission)', () => {
    setWindow(false);
    const attrs = buildRumGeoAttributes('US');
    expect(Object.keys(attrs).sort()).toEqual([GEO_REGION_ATTR, GEO_TIMEZONE_ATTR].sort());
  });

  it('coerces every value to a string (MetaAttributes must be strings)', () => {
    setWindow(false);
    for (const value of Object.values(buildRumGeoAttributes('US'))) {
      expect(typeof value).toBe('string');
    }
  });
});

describe('buildRumGeoAttributes — region (SSR-derived country code)', () => {
  it.each([
    ['US', 'US'],
    ['GB', 'GB'],
    ['us', 'US'], // uppercased — matches Cloudflare's uppercase cf-ipcountry emission
    [' de ', 'DE'], // trimmed + uppercased; idempotent on real values
  ])('passes through %p as %p', (input, expected) => {
    setWindow(false);
    expect(buildRumGeoAttributes(input)[GEO_REGION_ATTR]).toBe(expected);
  });

  it('keeps Cloudflare special 2-char tokens as their own bucket rather than flattening them', () => {
    // `T1` (Tor) and `XX` (unknown) are real cf-ipcountry emissions; the dashboard must be
    // able to see them distinctly, so only empty/null/whitespace maps to `unknown`.
    setWindow(false);
    expect(buildRumGeoAttributes('T1')[GEO_REGION_ATTR]).toBe('T1');
    expect(buildRumGeoAttributes('XX')[GEO_REGION_ATTR]).toBe('XX');
  });
});

describe('buildRumGeoAttributes — timezone (client IANA zone)', () => {
  it('resolves the browser timezone via Intl.DateTimeFormat().resolvedOptions().timeZone', () => {
    setWindow(true);
    mockTimeZone('America/New_York');
    expect(buildRumGeoAttributes('US')[GEO_TIMEZONE_ATTR]).toBe('America/New_York');
  });

  it('keeps the RAW IANA name — no case-normalization, no separator rewrite', () => {
    setWindow(true);
    mockTimeZone('America/Argentina/Buenos_Aires');
    expect(buildRumGeoAttributes('AR')[GEO_TIMEZONE_ATTR]).toBe('America/Argentina/Buenos_Aires');
  });

  it('falls back to `unknown` when Intl throws', () => {
    setWindow(true);
    mockTimeZone(() => {
      throw new Error('Intl unavailable');
    });
    const attrs = buildRumGeoAttributes('US');
    expect(attrs[GEO_TIMEZONE_ATTR]).toBe(GEO_UNKNOWN_VALUE);
    // The region side is unaffected by the timezone failure.
    expect(attrs[GEO_REGION_ATTR]).toBe('US');
  });

  it('falls back to `unknown` when the resolved timeZone is empty', () => {
    setWindow(true);
    mockTimeZone('');
    expect(buildRumGeoAttributes('US')[GEO_TIMEZONE_ATTR]).toBe(GEO_UNKNOWN_VALUE);
  });

  it('is `unknown` on the no-window (SSR) path while region is still set', () => {
    setWindow(false);
    const attrs = buildRumGeoAttributes('US');
    expect(attrs[GEO_TIMEZONE_ATTR]).toBe(GEO_UNKNOWN_VALUE);
    expect(attrs[GEO_REGION_ATTR]).toBe('US');
  });
});

describe('buildRumGeoAttributes — namespace disjointness', () => {
  it('never collides with the exp_* experiment attributes (the provider merges the two maps into ONE; a collision would overwrite a cohort)', () => {
    setWindow(false);
    const geoKeys = Object.keys(buildRumGeoAttributes('US'));
    const experimentKeys = Object.keys(buildRumExperimentAttributes({}));
    for (const geoKey of geoKeys) {
      expect(experimentKeys).not.toContain(geoKey);
    }
    for (const experimentKey of experimentKeys) {
      expect(geoKeys).not.toContain(experimentKey);
    }
  });

  it('geo keys carry no exp_ prefix (the Loki field namespaces stay greppable and separate)', () => {
    setWindow(false);
    for (const key of Object.keys(buildRumGeoAttributes('US'))) {
      expect(key.startsWith('exp_')).toBe(false);
    }
  });
});
