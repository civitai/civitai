import { describe, expect, it } from 'vitest';
import {
  FARO_LOKI_RETENTION_HOURS,
  FEEDBACK_ATTACHMENT_CAPTIONS,
  faroSessionLink,
  feedbackAreaOptions,
  feedbackAttachmentCount,
  feedbackAttachmentItems,
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

  /**
   * 🔴 THE REGISTRY HALF IS THE PRODUCER'S OWN CONSTANT NOW, NOT A COPY OF IT. This file used to
   * carry a hand-written `FEEDBACK_KNOWN_AREAS` mirroring `FEEDBACK_AREAS`, because that constant
   * lived in the Next app's `src/` where nothing here could reach it — so an area added on one side
   * was missing on the other and neither side could tell.
   *
   * The expectation is hand-typed rather than imported: importing `FEEDBACK_AREAS` to assert against
   * `FEEDBACK_AREAS` is a test that agrees with itself. Written out, a slug added or removed upstream
   * fails HERE with a diff, which is the moment to check the queue's filter still offers it.
   *
   * `bitdex-image-feed` is in the list on purpose: its producer was decommissioned 2026-09-01 and the
   * slug is kept so the historical rows filed under it stay reachable.
   */
  it('defaults its known areas to the shared registry the producer writes', () => {
    expect(feedbackAreaOptions([])).toEqual([
      'apps-marketplace',
      'bitdex-image-feed',
      'site-bug-report',
    ]);
  });
});

describe('splitContext', () => {
  it('names every key the panel renders', () => {
    // Realistic ids: the producer writes `randomUUID()`, and `splitContext` refuses anything that
    // is not shaped like a Cloudflare key — a short stand-in would be rejected here for a reason
    // that has nothing to do with what this case is about.
    const images = ['2f0b6a1e-0f7a-4f2e-9c3e-1a2b3c4d5e6f', '7c9a1d2b-3e4f-4a5b-8c9d-0e1f2a3b4c5d'];
    const screenshotId = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
    // Bound to consts and shared between input and expectation, as `images`/`screenshotId` above
    // already are. This assertion's property is IDENTITY — every key carried through unchanged —
    // so restating the literals on both sides would test the transcription, not the pass-through.
    const consoleErrors = ['TypeError: x is not a function'];
    const networkErrors = [
      { url: 'https://civitai.com/api/trpc/x', status: 500, initiatorType: 'fetch' },
    ];
    const ctx = splitContext({
      path: '/apps',
      filters: { kind: 'onsite' },
      images,
      screenshotId,
      sessionId: 'v913JNcgDs',
      consoleErrors,
      networkErrors,
    });

    // 🔴 A WHOLE-OBJECT `toEqual`, which makes this the LEDGER: a key added to `FeedbackContext`
    // without being added here fails with an object diff rather than passing unnoticed. That is
    // what it did when `consoleErrors`/`networkErrors` landed, which is the behaviour to keep.
    expect(ctx).toEqual({
      path: '/apps',
      filters: { kind: 'onsite' },
      images,
      screenshotId,
      sessionId: 'v913JNcgDs',
      consoleErrors: ['TypeError: x is not a function'],
      networkErrors: [
        { url: 'https://civitai.com/api/trpc/x', status: 500, initiatorType: 'fetch' },
      ],
      other: null,
    });
  });

  it('puts a key none of them cover into "other" — this is what stops a future area vanishing', () => {
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
        consoleErrors: [],
        networkErrors: [],
        other: null,
      });
    }
  });

  /**
   * The browser-error snapshot. The panel renders these as TEXT and builds no URL from them, so
   * unlike `images` there is no per-entry filter here — the guard that matters is the one in the
   * template, pinned in `feedback-panel-tripwires.test.ts`. What this block covers is the shape
   * routing: a well-formed array is carried, and anything else is VISIBLE under "other" rather
   * than silently shortened or dropped.
   */
  describe('the browser-error snapshot', () => {
    const ENTRY = { url: 'https://civitai.com/api/trpc/x', status: 500, initiatorType: 'fetch' };

    it('carries both arrays through', () => {
      const ctx = splitContext({ consoleErrors: ['boom', 'boom'], networkErrors: [ENTRY] });
      expect(ctx.consoleErrors).toEqual(['boom', 'boom']);
      expect(ctx.networkErrors).toEqual([ENTRY]);
      expect(ctx.other).toBeNull();
    });

    it('is empty arrays, never null, when the keys are absent — the ordinary case', () => {
      const ctx = splitContext({ path: '/apps' });
      expect(ctx.consoleErrors).toEqual([]);
      expect(ctx.networkErrors).toEqual([]);
    });

    it('carries a stored empty array without routing it to "other"', () => {
      const ctx = splitContext({ consoleErrors: [], networkErrors: [] });
      expect(ctx.consoleErrors).toEqual([]);
      expect(ctx.networkErrors).toEqual([]);
      expect(ctx.other).toBeNull();
    });

    it('keeps a duplicated console line — the same error twice IS the signal', () => {
      // Deliberately NOT deduplicated, unlike `images`. "This fired 6 times" is the useful fact,
      // and the panel keys by index so a repeat cannot make the row unopenable.
      const ctx = splitContext({ consoleErrors: ['same', 'same', 'same'] });
      expect(ctx.consoleErrors).toHaveLength(3);
    });

    it('shows the WHOLE array under "other" when one console entry is not a string', () => {
      // All-or-nothing: a moderator seeing 2 of 3 lines with no indication one was dropped is
      // worse off than one seeing the raw JSON.
      const value = ['ok', 42];
      const ctx = splitContext({ consoleErrors: value });
      expect(ctx.consoleErrors).toEqual([]);
      expect(ctx.other).toEqual({ consoleErrors: value });
    });

    it.each([
      ['a missing url', { status: 500, initiatorType: 'fetch' }],
      ['a missing status', { url: 'https://a.io/x', initiatorType: 'fetch' }],
      // 🔴 THE ONE THAT LOOKS SKIPPABLE. `initiatorType` is a closed set in the spec, so a guard
      // that omits it reads as complete — but the value comes from a JSONB column, not a browser,
      // and an object here renders as `[object Object]` in the queue instead of being dumped.
      ['a missing initiatorType', { url: 'https://a.io/x', status: 500 }],
      ['an object initiatorType', { url: 'https://a.io/x', status: 500, initiatorType: { a: 1 } }],
      ['a string status', { url: 'https://a.io/x', status: '500', initiatorType: 'fetch' }],
      ['a NaN status', { url: 'https://a.io/x', status: NaN, initiatorType: 'fetch' }],
      ['a bare string instead of an entry', 'https://a.io/x'],
      ['null instead of an entry', null],
      ['an array instead of an entry', []],
      // 🔴 THE DRIFT CASE, AND IT IS THE REASON THE GUARD CHECKS THE KEY COUNT. A `typeof`-only
      // guard passes this entry, the renderer draws its fixed three spans, and `method` appears
      // NOWHERE — not in the section and not under "Other context" either, because the key was
      // claimed. Silent and total, and the one drift direction the "other" bucket cannot cover.
      // The producer is a separate deployable, so this is reachable by shipping one repo.
      [
        'an entry with a field this app does not render',
        { url: 'https://a.io/x', status: 500, initiatorType: 'fetch', method: 'POST' },
      ],
    ])('routes a network array holding %s to "other"', (_label, bad) => {
      const ctx = splitContext({ networkErrors: [ENTRY, bad] });
      expect(ctx.networkErrors).toEqual([]);
      expect(ctx.other).toEqual({ networkErrors: [ENTRY, bad] });
    });

    it('routes a non-array to "other" rather than pretending the key was absent', () => {
      const ctx = splitContext({ consoleErrors: 'boom', networkErrors: { url: 'x' } });
      expect(ctx.consoleErrors).toEqual([]);
      expect(ctx.networkErrors).toEqual([]);
      expect(ctx.other).toEqual({ consoleErrors: 'boom', networkErrors: { url: 'x' } });
    });

    /**
     * 🔴 THE READ SIDE IMPOSES NO BOUNDS AND THAT IS DELIBERATE — this asserts the decision rather
     * than leaving it to be re-litigated. The producer bounds count, length and status range at
     * write time; re-imposing them here would send a row stored under a future widened bound to
     * the "other" bucket, which is a display regression, not a protection. Nothing on this side
     * does arithmetic with `status` or builds a URL from `url`.
     */
    it('carries a row that exceeds every producer-side bound, because storage is not validation', () => {
      const ctx = splitContext({
        consoleErrors: Array.from({ length: 50 }, () => 'x'.repeat(5000)),
        networkErrors: [{ url: 'https://a.io/x', status: 200, initiatorType: 'fetch' }],
      });
      expect(ctx.consoleErrors).toHaveLength(50);
      expect(ctx.networkErrors[0].status).toBe(200);
      expect(ctx.other).toBeNull();
    });

    /**
     * 🔴 HOSTILE TEXT IS CARRIED, NOT FILTERED, AND THE CONTAINMENT IS THE TEMPLATE. This pins
     * that `splitContext` does not quietly grow an `IMAGE_KEY`-style filter here — if one is ever
     * added, this test says so and its author has to state why. The reason none is needed is that
     * Svelte escapes interpolated text and the panel builds no `href`/`src` from these fields;
     * `feedback-panel-tripwires.test.ts` is what holds that end.
     */
    it('carries markup, a javascript: URL and an attacker origin through as plain data', () => {
      const hostile = '<img src=x onerror="fetch(`//evil.test`)">';
      const ctx = splitContext({
        consoleErrors: [hostile],
        networkErrors: [
          { url: 'javascript:alert(1)', status: 500, initiatorType: 'fetch' },
          { url: 'https://attacker.example/pixel.png', status: 404, initiatorType: 'img' },
        ],
      });
      expect(ctx.consoleErrors).toEqual([hostile]);
      expect(ctx.networkErrors.map((e) => e.url)).toEqual([
        'javascript:alert(1)',
        'https://attacker.example/pixel.png',
      ]);
    });
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

/**
 * 🔴 DRIFT GUARD FOR THE `IMAGE_KEY` FILTER — the thing standing between a stored id and an
 * `<img src>` in a moderator's browser.
 *
 * WHY A TEST AND NOT A COMMENT. The producer's schema now requires a uuid, which makes this filter
 * look redundant to anyone reading only that file. It is not: the producer binds WRITES ONLY, no
 * read path revalidates a stored row, and the producer is a separate deployable. A comment saying
 * so is exactly as deletable as the filter.
 *
 * ⚠ HONEST ACCOUNTING OF WHAT THIS BLOCK ADDS, because an earlier draft of this docblock
 * overstated it and was corrected by an audit round. Deleting `IMAGE_KEY` ALREADY failed tests
 * before this block existed: the `describe('splitContext')` block above covers a URL attachment id,
 * a scheme-like id, and a URL screenshot id — 3 cases, already spanning both fields. Measured
 * against a permissive `IMAGE_KEY`: 15 failures, 12 here and 3 there. So this block is a
 * WIDENING, not first coverage.
 *
 * What it actually adds: `other`-routing asserted on four further hostile shapes, an explicit
 * positive control (`other === null` on a clean context), and the two URL_36 cases below — the
 * only ones that separate a length coincidence from a shape check.
 *
 * It pins a RELATIONSHIP, not a symbol: the filter must be applied to BOTH fields, so a future
 * edit that drops it from one of them fails here. `IMAGE_KEY` is module-private, so there is
 * nothing structural to assert — and behavioural is the stronger claim anyway, since a structural
 * check passes over a filter wired to the wrong argument.
 *
 * The `length(36)` case is not decoration. A 36-character absolute URL is what distinguishes "this
 * value is uuid-SHAPED" from "this value is 36 characters long", and a guard that cannot tell those
 * apart is satisfied by a bound that still lets the attack through.
 */
describe('🔴 splitContext filters hostile image ids on BOTH fields', () => {
  const UUID = '11111111-2222-4333-8444-555555555555';
  // Exactly 36 characters — the length of a uuid — and still an absolute URL.
  const URL_36 = 'https://a.io/aaaaaaaaaaaaaaaaaaaaaaa';

  const hostile: Array<[string, string]> = [
    ['an absolute https URL', 'https://attacker.example/x.png'],
    ['a 36-character absolute URL', URL_36],
    ['a protocol-relative URL', '//attacker.example/x.png'],
    ['a blob URL', 'blob:https://civitai.com/abcd'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['a traversal', '../../etc/passwd'],
  ];

  it('the 36-char case really is uuid-length, or it is testing nothing', () => {
    expect(URL_36).toHaveLength(UUID.length);
  });

  it.each(hostile)('drops %s from images, and still shows it under other', (_label, value) => {
    const out = splitContext({ images: [UUID, value] });
    expect(out.images).toEqual([UUID]);
    expect(out.other?.images).toEqual([UUID, value]);
  });

  it.each(hostile)('refuses %s as a screenshotId, and routes it to other', (_label, value) => {
    const out = splitContext({ screenshotId: value });
    expect(out.screenshotId).toBeNull();
    expect(out.other?.screenshotId).toBe(value);
  });

  // The positive control: the cases above fail BECAUSE the values are hostile, not because the
  // fields reject everything.
  it('still carries a well-formed id through on both fields', () => {
    const out = splitContext({ images: [UUID], screenshotId: UUID });
    expect(out.images).toEqual([UUID]);
    expect(out.screenshotId).toBe(UUID);
    expect(out.other).toBeNull();
  });

  /**
   * 🔴 THE SAME FILTER, ASSERTED AT THE NEW EXIT. The panel used to be the only consumer of these two
   * fields; the lightbox is a second one, and it is the one that renders the id at full size. This
   * extends the block above rather than repeating it: what is new is not the filter, it is that
   * `feedbackAttachmentItems` sits DOWNSTREAM of it on the panel's one live path. Not "cannot be
   * handed anything else" — `FeedbackContext` is a structural type, so a hand-built object of that
   * shape type-checks and a cast defeats it; the compile error only catches the accident.
   *
   * The structural half is the TYPE — `feedbackAttachmentItems` accepts `FeedbackContext`, which is
   * `splitContext`'s return type, so `row.context` does not typecheck there. That alone is not a
   * guard worth trusting (a cast defeats it), so the behaviour is pinned here.
   *
   * The mixed case is the one that carries the claim. A hostile-only fixture yields an empty list,
   * and an empty list is also what a function wired to nothing returns — so the assertion that means
   * something is "the clean id survived AND the hostile one did not", in the same call.
   */
  const SECOND_UUID = '99999999-8888-4777-8666-555555555555';

  it.each(hostile)('cannot route %s into a lightbox frame', (_label, value) => {
    const items = feedbackAttachmentItems(splitContext({ images: [UUID, value] }));

    expect(items.map((i) => i.id)).toEqual([UUID]);
    expect(items).toHaveLength(1);
  });

  it.each(hostile)('cannot route %s into a lightbox frame as the screenshot', (_label, value) => {
    const items = feedbackAttachmentItems(splitContext({ images: [UUID], screenshotId: value }));

    expect(items.map((i) => i.id)).toEqual([UUID]);
    expect(items.some((i) => i.caption === FEEDBACK_ATTACHMENT_CAPTIONS.screenshot)).toBe(false);
  });

  it('yields nothing at all when every id is hostile', () => {
    const context = splitContext({
      images: ['https://attacker.example/x.png'],
      screenshotId: 'blob:https://civitai.com/abcd',
    });
    expect(feedbackAttachmentItems(context)).toEqual([]);
  });

  /**
   * 🔴 TWO FRAMES CAN SHARE AN ID, SO NOTHING MAY KEY AN `{#each}` ON `item.id`. `splitContext`
   * deduplicates `images` among THEMSELVES and nothing compares `screenshotId` against them — the
   * reporter attaching the same file the page capture produced is an ordinary row, not a hostile
   * one. Svelte THROWS on a duplicate `{#each … (key)}` in production as well as in dev, which would
   * make that report permanently unopenable; `FeedbackAttachments.svelte` keys by index because of
   * this case. Both frames are kept rather than collapsed: they are two different claims about the
   * same file, and the captions are what say so.
   */
  it('keeps both frames when the capture repeats an attached id — ids here are NOT unique', () => {
    const items = feedbackAttachmentItems(splitContext({ images: [UUID], screenshotId: UUID }));

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toEqual([UUID, UUID]);
    expect(items.map((i) => i.caption)).toEqual([
      FEEDBACK_ATTACHMENT_CAPTIONS.image,
      FEEDBACK_ATTACHMENT_CAPTIONS.screenshot,
    ]);
  });

  /**
   * 🔴 THE TWO CAPTIONS ARE NOT INTERCHANGEABLE. A file the reporter attached is theirs; the opt-in
   * capture is a picture of their screen, which can hold another user's content. The lightbox carries
   * the caption into the large view for exactly that reason, so which frame gets which is pinned,
   * along with the order the panel renders them in.
   */
  it('captions each frame by provenance, with the opt-in capture last', () => {
    const items = feedbackAttachmentItems(
      splitContext({
        images: [UUID, SECOND_UUID],
        screenshotId: '11112222-3333-4444-8555-666677778888',
      })
    );

    expect(items).toEqual([
      { id: UUID, caption: 'Attached by the reporter' },
      { id: SECOND_UUID, caption: 'Attached by the reporter' },
      {
        id: '11112222-3333-4444-8555-666677778888',
        caption: 'Opt-in capture of their own viewport',
      },
    ]);
  });

  it('gives the two kinds different words, or the distinction is not on screen', () => {
    expect(FEEDBACK_ATTACHMENT_CAPTIONS.image).not.toBe(FEEDBACK_ATTACHMENT_CAPTIONS.screenshot);
  });

  /**
   * The 📎 column and the lightbox must never disagree about what is on a row. `feedbackAttachmentCount`
   * is derived from this list rather than re-adding the two fields, so this pins that they stayed one
   * rule — including on a row where the screenshot is REFUSED, which is where two open-coded copies
   * would drift first.
   */
  it('counts exactly the frames the lightbox will show, refusals included', () => {
    const clean = splitContext({ images: [UUID, SECOND_UUID], screenshotId: UUID });
    expect(feedbackAttachmentCount(clean)).toBe(feedbackAttachmentItems(clean).length);
    expect(feedbackAttachmentCount(clean)).toBe(3);

    const refused = splitContext({
      images: [UUID],
      screenshotId: 'https://attacker.example/x.png',
    });
    expect(feedbackAttachmentCount(refused)).toBe(feedbackAttachmentItems(refused).length);
    expect(feedbackAttachmentCount(refused)).toBe(1);
  });
});
