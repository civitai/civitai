import { describe, expect, it } from 'vitest';
import {
  buildResourceMeasurement,
  classifyApiEntry,
  computeResourcePhases,
  createRateLimiter,
  normalizeApiRoute,
  parseMaxPerWindow,
  parseSampleRate,
  RESOURCE_TIMING_DEFAULTS,
  RESOURCE_TIMING_MEASUREMENT_TYPE,
  resolveResourceTimingConfig,
  type ResourceTimingLike,
  sanitizeProtocol,
} from '~/utils/faro/resourceTiming';

const ORIGIN = 'https://civitai.com';

/** Build a PerformanceResourceTiming-shaped object with sensible full-timing defaults. */
function entry(overrides: Partial<ResourceTimingLike> = {}): ResourceTimingLike {
  return {
    name: `${ORIGIN}/api/trpc/model.getById?batch=1&input=%7B%7D`,
    initiatorType: 'fetch',
    nextHopProtocol: 'h2',
    // A clean, non-reused connection: 0 → dns → connect(+tls) → request → response → end.
    domainLookupStart: 10,
    domainLookupEnd: 25, // DNS = 15
    connectStart: 25,
    secureConnectionStart: 40,
    connectEnd: 60, // connect = 35, tls = 20
    requestStart: 60,
    responseStart: 210, // ttfb = 150
    responseEnd: 260, // download = 50
    duration: 250, // total
    ...overrides,
  };
}

describe('normalizeApiRoute', () => {
  it('keeps only the first two path segments (coarse route)', () => {
    expect(normalizeApiRoute('/api/trpc/model.getById')).toBe('/api/trpc');
    expect(normalizeApiRoute('/api/v1/models/12345')).toBe('/api/v1');
    expect(normalizeApiRoute('/api/auth/session')).toBe('/api/auth');
    expect(normalizeApiRoute('/api/webhooks/stripe/abc')).toBe('/api/webhooks');
  });

  it('handles a bare /api and trailing/duplicate slashes', () => {
    expect(normalizeApiRoute('/api')).toBe('/api');
    expect(normalizeApiRoute('/api/')).toBe('/api');
    expect(normalizeApiRoute('/api//trpc//x')).toBe('/api/trpc');
  });
});

describe('sanitizeProtocol', () => {
  it('passes known ALPN protocols through (lowercased)', () => {
    expect(sanitizeProtocol('h2')).toBe('h2');
    expect(sanitizeProtocol('h3')).toBe('h3');
    expect(sanitizeProtocol('HTTP/1.1')).toBe('http/1.1');
  });
  it('collapses unknown/empty protocols to a low-cardinality bucket', () => {
    expect(sanitizeProtocol('quic-v99')).toBe('other');
    expect(sanitizeProtocol('')).toBe('unknown');
    expect(sanitizeProtocol(undefined)).toBe('unknown');
  });
});

describe('classifyApiEntry — same-origin /api filter', () => {
  it('accepts a same-origin /api fetch and returns the coarse route', () => {
    expect(classifyApiEntry(entry(), ORIGIN)).toBe('/api/trpc');
  });

  it('accepts xmlhttprequest initiator', () => {
    expect(classifyApiEntry(entry({ initiatorType: 'xmlhttprequest' }), ORIGIN)).toBe('/api/trpc');
  });

  it('ignores non-/api same-origin resources (e.g. a page/data route)', () => {
    expect(classifyApiEntry(entry({ name: `${ORIGIN}/models/123` }), ORIGIN)).toBeNull();
    expect(classifyApiEntry(entry({ name: `${ORIGIN}/apixyz/thing` }), ORIGIN)).toBeNull();
  });

  it('ignores third-party (cross-origin) resources even on an /api path', () => {
    expect(
      classifyApiEntry(entry({ name: 'https://api.stripe.com/api/v1/charges' }), ORIGIN)
    ).toBeNull();
    expect(
      classifyApiEntry(entry({ name: 'https://ga.google.com/api/collect' }), ORIGIN)
    ).toBeNull();
  });

  it('ignores non fetch/xhr initiators (img/script/css/link)', () => {
    for (const initiatorType of ['img', 'script', 'css', 'link', 'other', 'navigation']) {
      expect(classifyApiEntry(entry({ initiatorType }), ORIGIN)).toBeNull();
    }
  });
});

describe('computeResourcePhases — phase math', () => {
  it('computes DNS/connect/TLS/TTFB/download/total from a full-timing entry', () => {
    expect(computeResourcePhases(entry())).toEqual({
      rt_dns: 15,
      rt_connect: 35,
      rt_tls: 20,
      rt_ttfb: 150,
      rt_download: 50,
      rt_total: 250,
      rt_reused: 0,
    });
  });

  it('rounds sub-millisecond jitter to integer ms', () => {
    const values = computeResourcePhases(
      entry({ domainLookupStart: 10.2, domainLookupEnd: 25.9 }) // 15.7 → 16
    );
    expect(values.rt_dns).toBe(16);
  });

  it('cache/keep-alive reuse: zero connect markers → dns/connect/tls all 0 and rt_reused=1', () => {
    // Reused connection: DNS + connect skipped (all their markers 0); request/response still real.
    const reused = entry({
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      connectEnd: 0,
      secureConnectionStart: 0,
      requestStart: 100,
      responseStart: 180, // ttfb = 80
      responseEnd: 200, // download = 20
      duration: 100,
    });
    expect(computeResourcePhases(reused)).toEqual({
      rt_dns: 0,
      rt_connect: 0,
      rt_tls: 0,
      rt_ttfb: 80,
      rt_download: 20,
      rt_total: 100,
      rt_reused: 1,
    });
  });

  it('no-TLS (plain http / secureConnectionStart === 0): tls=0 but connect still measured', () => {
    const noTls = entry({ secureConnectionStart: 0 }); // connectStart 25 → connectEnd 60 = 35
    const values = computeResourcePhases(noTls);
    expect(values.rt_tls).toBe(0);
    expect(values.rt_connect).toBe(35);
    expect(values.rt_reused).toBe(0);
  });

  it('never emits a negative phase (clamped to 0 on out-of-order markers)', () => {
    const weird = entry({ responseStart: 60, requestStart: 210 }); // would be -150
    expect(computeResourcePhases(weird).rt_ttfb).toBe(0);
  });
});

describe('buildResourceMeasurement — the emitted payload', () => {
  it('returns the stable measurement type + numeric values + low-cardinality context', () => {
    const m = buildResourceMeasurement(entry(), ORIGIN);
    expect(m).not.toBeNull();
    expect(m!.type).toBe(RESOURCE_TIMING_MEASUREMENT_TYPE);
    expect(m!.type).toBe('resource_timing');
    expect(m!.context).toEqual({ route: '/api/trpc', protocol: 'h2' });
    expect(m!.values.rt_ttfb).toBe(150);
    // Every value is a number (unwrap-friendly for the dashboard).
    for (const v of Object.values(m!.values)) expect(typeof v).toBe('number');
  });

  it('returns null for a resource that is not same-origin /api fetch/xhr', () => {
    expect(buildResourceMeasurement(entry({ initiatorType: 'img' }), ORIGIN)).toBeNull();
    expect(
      buildResourceMeasurement(entry({ name: 'https://cdn.other.com/api/x' }), ORIGIN)
    ).toBeNull();
  });

  // 🔴 PRIVACY GUARANTEE — the central assertion of this feature.
  it('NEVER leaks the full URL, query string, or ids into the emitted payload', () => {
    const sensitive = entry({
      // A URL carrying an id, a slug, an oauth code and an email — none may escape.
      name: `${ORIGIN}/api/auth/callback/credentials?code=SECRETCODE123&email=user%40example.com&modelId=99887766&slug=some-nsfw-model-name`,
    });
    const m = buildResourceMeasurement(sensitive, ORIGIN);
    expect(m).not.toBeNull();

    // The route is coarse and carries none of the sensitive tail.
    expect(m!.context.route).toBe('/api/auth');

    // Serialize the ENTIRE emitted payload and assert not one sensitive token survives.
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain('SECRETCODE123');
    expect(serialized).not.toContain('example.com');
    expect(serialized).not.toContain('99887766');
    expect(serialized).not.toContain('some-nsfw-model-name');
    expect(serialized).not.toContain('callback');
    expect(serialized).not.toContain('credentials');
    expect(serialized).not.toContain('?'); // no query string anywhere
    expect(serialized).not.toContain('code=');
    expect(serialized).not.toContain('=user'); // no email fragment
    // The only path-shaped string in the payload is the coarse route.
    expect(serialized).not.toContain(sensitive.name);
  });
});

describe('createRateLimiter — the volume gate', () => {
  it('allows up to maxPerWindow then drops within a window (sampleRate 1 = no sampling)', () => {
    const limiter = createRateLimiter({
      maxPerWindow: 3,
      windowMs: 1000,
      sampleRate: 1,
      now: () => 0, // frozen clock → single window
    });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false); // cap reached
    expect(limiter.allow()).toBe(false);
  });

  it('resets the cap after the rolling window elapses', () => {
    let t = 0;
    const limiter = createRateLimiter({
      maxPerWindow: 1,
      windowMs: 1000,
      sampleRate: 1,
      now: () => t,
    });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    t = 1000; // window elapsed
    expect(limiter.allow()).toBe(true);
  });

  it('sampleRate drops candidates before the cap is consumed', () => {
    // random() always returns 0.9; with sampleRate 0.25, 0.9 >= 0.25 → always dropped,
    // and a dropped candidate must NOT consume a window slot.
    const limiter = createRateLimiter({
      maxPerWindow: 100,
      windowMs: 1000,
      sampleRate: 0.25,
      random: () => 0.9,
      now: () => 0,
    });
    for (let i = 0; i < 50; i++) expect(limiter.allow()).toBe(false);
  });

  it('sampleRate passes candidates when random() is below the fraction', () => {
    const limiter = createRateLimiter({
      maxPerWindow: 100,
      windowMs: 1000,
      sampleRate: 0.25,
      random: () => 0.1, // 0.1 < 0.25 → passes the sample
      now: () => 0,
    });
    expect(limiter.allow()).toBe(true);
  });
});

describe('RESOURCE_TIMING_DEFAULTS', () => {
  // The default sample rate is 0.05 (NOT 0.25) so the aggregate resource-timing volume keeps the
  // shared `source="faro-rum"` Loki stream under its 10 MB/s per-stream ceiling at civitai's
  // 100k-concurrent target. This assertion guards that scale decision against a silent regression.
  it('defaults sampleRate to 0.05 for the Loki per-stream ceiling', () => {
    expect(RESOURCE_TIMING_DEFAULTS.sampleRate).toBe(0.05);
  });

  it('keeps the per-client belt at 8 emissions / 15s window', () => {
    expect(RESOURCE_TIMING_DEFAULTS.maxPerWindow).toBe(8);
    expect(RESOURCE_TIMING_DEFAULTS.windowMs).toBe(15000);
  });
});

describe('parseSampleRate', () => {
  it('parses a valid fraction and clamps into [0, 1]', () => {
    expect(parseSampleRate('0.05', 0.05)).toBe(0.05);
    expect(parseSampleRate('0.5', 0.05)).toBe(0.5);
    expect(parseSampleRate('2', 0.05)).toBe(1);
    expect(parseSampleRate('-1', 0.05)).toBe(0);
  });

  it('falls back on NaN / unset / non-numeric input', () => {
    expect(parseSampleRate(undefined, 0.05)).toBe(0.05);
    expect(parseSampleRate('', 0.05)).toBe(0.05);
    expect(parseSampleRate('not-a-number', 0.05)).toBe(0.05);
  });
});

describe('parseMaxPerWindow', () => {
  it('parses a positive integer', () => {
    expect(parseMaxPerWindow('8', 8)).toBe(8);
    expect(parseMaxPerWindow('20', 8)).toBe(20);
    expect(parseMaxPerWindow('12.9', 8)).toBe(12); // parseInt truncates
  });

  it('falls back on NaN / unset / invalid / non-positive input', () => {
    expect(parseMaxPerWindow(undefined, 8)).toBe(8);
    expect(parseMaxPerWindow('', 8)).toBe(8);
    expect(parseMaxPerWindow('abc', 8)).toBe(8);
    expect(parseMaxPerWindow('0', 8)).toBe(8);
    expect(parseMaxPerWindow('-3', 8)).toBe(8);
  });
});

describe('resolveResourceTimingConfig — the deploy-tunable knobs', () => {
  it('reads sample rate + cap from their env strings', () => {
    expect(resolveResourceTimingConfig('0.1', '20')).toEqual({ sampleRate: 0.1, maxPerWindow: 20 });
  });

  it('falls back to the defaults on invalid/NaN env (never zeroes the gate or crashes)', () => {
    expect(resolveResourceTimingConfig('garbage', 'garbage')).toEqual({
      sampleRate: RESOURCE_TIMING_DEFAULTS.sampleRate,
      maxPerWindow: RESOURCE_TIMING_DEFAULTS.maxPerWindow,
    });
    expect(resolveResourceTimingConfig(undefined, undefined)).toEqual({
      sampleRate: 0.05,
      maxPerWindow: 8,
    });
  });

  it('resolves each knob independently (one invalid does not taint the other)', () => {
    expect(resolveResourceTimingConfig('0.2', 'nope')).toEqual({
      sampleRate: 0.2,
      maxPerWindow: 8,
    });
    expect(resolveResourceTimingConfig('nope', '16')).toEqual({
      sampleRate: 0.05,
      maxPerWindow: 16,
    });
  });
});
