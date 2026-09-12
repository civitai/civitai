import { describe, expect, it } from 'vitest';
import {
  FARO_LOKI_RETENTION_HOURS,
  faroSessionLink,
  feedbackAreaOptions,
  feedbackAttachmentCount,
  handledByLabel,
  reconstructFeedbackUrl,
  splitContext,
} from '$lib/feedback';

/**
 * The pure decisions behind `/feedback`. Every one of them fails SILENTLY when wrong — a link to a
 * page the report is not about, an area whose rows nobody can reach, a Grafana query that returns
 * some rows, a context key that vanishes.
 */

const HOUR = 60 * 60 * 1000;

describe('reconstructFeedbackUrl', () => {
  it('omits every value that equals the store default, so the link is the one the reporter had', () => {
    expect(
      reconstructFeedbackUrl('/apps', {
        kind: 'all',
        category: 'none',
        sort: 'top-rated',
        query: '',
      })
    ).toBe('/apps');
  });

  it('round-trips a non-default combination', () => {
    expect(
      reconstructFeedbackUrl('/apps', {
        kind: 'onsite',
        category: 'none',
        sort: 'newest',
        query: '',
      })
    ).toBe('/apps?kind=onsite&sort=newest');
  });

  it('carries a real category and a real search term', () => {
    expect(
      reconstructFeedbackUrl('/apps', {
        kind: 'all',
        category: 'generation',
        sort: 'top-rated',
        query: 'upscale',
      })
    ).toBe('/apps?category=generation&query=upscale');
  });

  it('encodes a search term that would otherwise change the URL', () => {
    expect(reconstructFeedbackUrl('/apps', { query: 'a&b=c' })).toBe('/apps?query=a%26b%3Dc');
  });

  it('carries a key it has never seen rather than dropping a future area on the floor', () => {
    expect(reconstructFeedbackUrl('/browse', { tab: 'videos' })).toBe('/browse?tab=videos');
  });

  it('is just the path when there are no filters at all — the site-bug-report shape', () => {
    expect(reconstructFeedbackUrl('/models/123')).toBe('/models/123');
  });

  it('yields NO link when `path` is absent, rather than a confident link to /', () => {
    expect(reconstructFeedbackUrl(undefined, { kind: 'onsite' })).toBeNull();
    expect(reconstructFeedbackUrl(null)).toBeNull();
  });

  it('refuses a `path` that is not a same-origin path — it is client-supplied', () => {
    expect(reconstructFeedbackUrl('https://evil.example/x')).toBeNull();
    expect(reconstructFeedbackUrl('apps')).toBeNull();
    // 🔴 `//host` passes a naive `startsWith('/')` and becomes a HOST SWAP once concatenated onto
    // the civitai base.
    expect(reconstructFeedbackUrl('//evil.example/x')).toBeNull();
  });
});

describe('feedbackAreaOptions', () => {
  it('keeps an area that exists ONLY in the table — the whole reason the union exists', () => {
    // `bitdex-image-feed`'s producer is gone. Reading the TS registry alone would hide its rows.
    expect(feedbackAreaOptions(['bitdex-image-feed'], ['apps-marketplace'])).toEqual([
      'apps-marketplace',
      'bitdex-image-feed',
    ]);
  });

  it('keeps an area that exists ONLY in the registry, so a new surface is filterable before it has rows', () => {
    expect(feedbackAreaOptions([], ['site-bug-report'])).toEqual(['site-bug-report']);
  });

  it('does not repeat an area present in both', () => {
    expect(feedbackAreaOptions(['apps-marketplace'], ['apps-marketplace'])).toEqual([
      'apps-marketplace',
    ]);
  });

  it('drops an empty area string rather than offering a blank option', () => {
    expect(feedbackAreaOptions([''], ['apps-marketplace'])).toEqual(['apps-marketplace']);
  });
});

describe('splitContext', () => {
  it('names the five keys the panel renders', () => {
    // Realistic ids: the producer writes `randomUUID()`, and `splitContext` refuses anything that
    // is not shaped like a Cloudflare key — a short stand-in would be rejected here for a reason
    // that has nothing to do with what this case is about.
    const images = ['2f0b6a1e-0f7a-4f2e-9c3e-1a2b3c4d5e6f', '7c9a1d2b-3e4f-4a5b-8c9d-0e1f2a3b4c5d'];
    const screenshotId = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
    const ctx = splitContext({
      path: '/apps',
      filters: { kind: 'onsite' },
      images,
      screenshotId,
      sessionId: 'v913JNcgDs',
    });

    expect(ctx).toEqual({
      path: '/apps',
      filters: { kind: 'onsite' },
      images,
      screenshotId,
      sessionId: 'v913JNcgDs',
      other: null,
    });
  });

  it('puts a key none of the five cover into "other" — this is what stops a future area vanishing', () => {
    const ctx = splitContext({ path: '/apps', pagesLoaded: 3, reportedSource: 'edge' });

    expect(ctx.other).toEqual({ pagesLoaded: 3, reportedSource: 'edge' });
    expect(ctx.path).toBe('/apps');
  });

  it('shows a known key holding the wrong TYPE instead of pretending it was absent', () => {
    const ctx = splitContext({ path: 42, images: 'not-an-array' });

    expect(ctx.path).toBeNull();
    expect(ctx.images).toEqual([]);
    expect(ctx.other).toEqual({ path: 42, images: 'not-an-array' });
  });

  it('survives a context that is not an object — the column has no schema at rest', () => {
    for (const bad of [null, undefined, 'x', 7, []]) {
      expect(splitContext(bad)).toEqual({
        path: null,
        filters: null,
        images: [],
        screenshotId: null,
        sessionId: null,
        other: null,
      });
    }
  });

  /**
   * 🔴 A SECURITY GUARD, not tidiness. `getEdgeUrl` returns its argument VERBATIM when it starts
   * with `http` or `blob`, and the producer bounds these ids by LENGTH ONLY — so an unfiltered
   * value renders `<img src="https://attacker.example/…">` in a moderator's browser and hands the
   * reporter a read receipt naming who opened their report and when.
   */
  it('refuses an attachment id that is a URL, and still shows it as text', () => {
    const ctx = splitContext({ images: ['https://attacker.example/x.png', 'real-image-key-1'] });

    expect(ctx.images).toEqual(['real-image-key-1']);
    expect(ctx.other).toEqual({ images: ['https://attacker.example/x.png', 'real-image-key-1'] });
  });

  /**
   * `getEdgeUrl` takes its verbatim branch on ANY value starting with `http`/`blob`, so an id
   * spelled like one renders as a broken same-origin relative src instead of a CDN URL.
   */
  it('refuses an id spelled like a URL scheme even though it cannot BE a URL', () => {
    expect(splitContext({ images: ['httpabcdefgh', 'blobabcdefgh'] }).images).toEqual([]);
  });

  it('refuses a screenshot id that is a URL', () => {
    const ctx = splitContext({ screenshotId: 'https://attacker.example/x.png' });

    expect(ctx.screenshotId).toBeNull();
    expect(ctx.other).toEqual({ screenshotId: 'https://attacker.example/x.png' });
  });

  /**
   * 🔴 `{#each … (id)}` THROWS on a duplicate key in production as well as dev, so one repeated id
   * in a client-supplied array makes that report permanently unopenable.
   */
  it('deduplicates attachment ids', () => {
    expect(splitContext({ images: ['same-image-key', 'same-image-key'] }).images).toEqual([
      'same-image-key',
    ]);
  });

  it('counts the opt-in capture as an attachment alongside the reporter’s own files', () => {
    expect(
      feedbackAttachmentCount(
        splitContext({ images: ['image-key-a', 'image-key-b'], screenshotId: 'shot-key-1' })
      )
    ).toBe(3);
    expect(feedbackAttachmentCount(splitContext({}))).toBe(0);
  });
});

/**
 * 🔴 Two INDEPENDENT nullables, and the two views of this row had drifted into being wrong in
 * opposite directions — each correct for exactly the case the other got wrong. `handledById` is
 * `ON DELETE SET NULL`; `User.username` is itself nullable.
 */
describe('handledByLabel', () => {
  const at = new Date('2026-09-01T00:00:00.000Z');

  it('names the handler when there is one', () => {
    expect(handledByLabel({ handledByUsername: 'mod', handledById: 42, handledAt: at })).toBe(
      'mod'
    );
  });

  it('falls back to the id for a LIVE account with no username — not "deleted account"', () => {
    expect(handledByLabel({ handledByUsername: null, handledById: 42, handledAt: at })).toBe('#42');
  });

  it('says the account is gone when the FK was nulled — not "#null"', () => {
    expect(handledByLabel({ handledByUsername: null, handledById: null, handledAt: at })).toBe(
      'deleted account'
    );
  });

  it('is a dash for an unhandled row, whatever the other columns say', () => {
    expect(handledByLabel({ handledByUsername: 'mod', handledById: 42, handledAt: null })).toBe(
      '—'
    );
  });
});

describe('faroSessionLink', () => {
  const CREATED = new Date('2026-09-11T12:00:00.000Z');
  const GRAFANA = 'https://grafana.example.test';
  const SESSION = 'v913JNcgDs';

  const link = (over: Partial<Parameters<typeof faroSessionLink>[0]> = {}) =>
    faroSessionLink({
      grafanaUrl: GRAFANA,
      sessionId: SESSION,
      createdAt: CREATED,
      now: CREATED.getTime() + HOUR,
      ...over,
    });

  /** The Explore pane, decoded back out of the built URL. */
  const pane = (url: string) => {
    const panes = new URL(url).searchParams.get('panes');
    if (!panes) throw new Error('the built URL carries no `panes` parameter');
    return JSON.parse(panes) as {
      faro: {
        queries: { expr: string; datasource: { uid: string } }[];
        range: { from: string; to: string };
      };
    };
  };

  it('builds an Explore URL inside the retention window', () => {
    const url = link();
    expect(url).not.toBeNull();
    expect(new URL(url!).pathname).toBe('/explore');
    expect(new URL(url!).searchParams.get('schemaVersion')).toBe('1');
    expect(new URL(url!).searchParams.get('orgId')).toBe('1');
  });

  /**
   * 🔴 THE TWO-SPELLINGS HAZARD, as something a machine can check. The id appears as `session_id=`
   * on `session_start` lines and as `event_data_session.id=` on `faro.tracing.fetch` lines, so a
   * `| logfmt | session_id="…"` filter matches the first and silently drops the second — exactly
   * the rows carrying traceID/spanID. A filter that returns SOME rows looks like it worked.
   */
  it('filters by raw substring and never by logfmt', () => {
    const url = link()!;
    const expr = pane(url).faro.queries[0].expr;

    expect(expr).toContain(`|= "${SESSION}"`);
    expect(expr).not.toContain('logfmt');
    // Belt and braces: no encoding of `logfmt` can be hiding anywhere in the URL either.
    expect(decodeURIComponent(url)).not.toContain('logfmt');
  });

  it('points at the pinned Loki datasource uid', () => {
    expect(pane(link()!).faro.queries[0].datasource.uid).toBe('loki');
  });

  it('centres the window on the report, not on now — it must survive being clicked two days later', () => {
    const range = pane(link()!).faro.range;
    expect(range.from).toBe(String(CREATED.getTime() - HOUR));
    expect(range.to).toBe(String(CREATED.getTime() + HOUR));
  });

  it('escapes a session id that would otherwise break out of the LogQL string literal', () => {
    const expr = pane(link({ sessionId: 'a"b\\c' })!).faro.queries[0].expr;
    expect(expr).toBe('{source="faro-rum"} |= "a\\"b\\\\c"');
  });

  it('is null past the retention window — the caller renders the expiry note instead', () => {
    expect(link({ now: CREATED.getTime() + (FARO_LOKI_RETENTION_HOURS + 1) * HOUR })).toBeNull();
  });

  /**
   * The boundary is CLOSED ON THE EXPIRED SIDE: at exactly the retention age the sample is at the
   * edge of eviction, and a link that resolves to nothing is the one outcome this design exists to
   * avoid. Pinned rather than left to whichever comparison operator got typed.
   */
  it('treats an age of exactly the retention window as expired', () => {
    const boundary = CREATED.getTime() + FARO_LOKI_RETENTION_HOURS * HOUR;
    expect(link({ now: boundary })).toBeNull();
    expect(link({ now: boundary - 1 })).not.toBeNull();
  });

  it('is null with no session id, rather than a URL with `undefined` in it', () => {
    expect(link({ sessionId: null })).toBeNull();
    expect(link({ sessionId: '   ' })).toBeNull();
  });

  it('is null when PUBLIC_GRAFANA_URL is unset, rather than linking to `undefined/explore`', () => {
    expect(link({ grafanaUrl: undefined })).toBeNull();
    expect(link({ grafanaUrl: '' })).toBeNull();
  });

  it('does not double the slash when the configured base carries a trailing one', () => {
    expect(link({ grafanaUrl: `${GRAFANA}/` })!.startsWith(`${GRAFANA}/explore?`)).toBe(true);
  });
});
