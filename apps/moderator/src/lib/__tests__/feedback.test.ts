import { describe, expect, it } from 'vitest';
import {
  FARO_LOKI_RETENTION_HOURS,
  faroSessionLink,
  feedbackAreaOptions,
  feedbackAttachmentCount,
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

  it('refuses a `path` that is not a path — it is client-supplied', () => {
    expect(reconstructFeedbackUrl('https://evil.example/x')).toBeNull();
    expect(reconstructFeedbackUrl('apps')).toBeNull();
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
    const ctx = splitContext({
      path: '/apps',
      filters: { kind: 'onsite' },
      images: ['img-1', 'img-2'],
      screenshotId: 'shot-1',
      sessionId: 'v913JNcgDs',
    });

    expect(ctx).toEqual({
      path: '/apps',
      filters: { kind: 'onsite' },
      images: ['img-1', 'img-2'],
      screenshotId: 'shot-1',
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

  it('counts the opt-in capture as an attachment alongside the reporter’s own files', () => {
    expect(feedbackAttachmentCount(splitContext({ images: ['a', 'b'], screenshotId: 's' }))).toBe(3);
    expect(feedbackAttachmentCount(splitContext({}))).toBe(0);
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
    expect(
      link({ now: CREATED.getTime() + (FARO_LOKI_RETENTION_HOURS + 1) * HOUR })
    ).toBeNull();
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
