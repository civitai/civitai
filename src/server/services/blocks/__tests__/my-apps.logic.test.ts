import { describe, expect, it } from 'vitest';
import {
  buildMyApps as buildMyAppsHome,
  MY_APPS_MAX_ROWS,
  type BuildMyAppsOptions,
  type MyAppsListingCandidate,
  type MyAppsSignals,
} from '~/server/services/blocks/my-apps.logic';
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';

/**
 * The pure rules behind the `/apps` "My apps" home: which apps a viewer HAS, deduped per
 * listing, filtered by the store's own visibility gate, ordered most-recent first.
 *
 * Fixtures are pairwise distinct on every axis an assertion reads (ids, App Block ids,
 * client ids, slugs, names, timestamps), so a mutant that swaps two fields or reads the
 * wrong source cannot produce the expected value by coincidence.
 */

const at = (iso: string) => new Date(iso);

/** The rows alone, for the cases that are not about hides. */
const buildMyApps = (...args: Parameters<typeof buildMyAppsHome>) => buildMyAppsHome(...args).apps;

const BASE_OPTS: BuildMyAppsOptions = {
  scope: 'full',
  floor: 'public',
  redCapable: false,
  canOpenPage: true,
  recentSince: at('2026-10-01T00:00:00.000Z'),
};

const NO_SIGNALS: MyAppsSignals = { grants: [], entitlements: [], invocations: [], consents: [] };

function pageApp(args: {
  id: string;
  slug: string;
  name: string;
  appBlockId: string;
  status?: string;
  visibility?: AppListingVisibility | null;
  deployedAt?: Date | null;
  hasPage?: boolean;
  contentRating?: string | null;
}): MyAppsListingCandidate {
  return {
    card: {
      id: args.id,
      slug: args.slug,
      name: args.name,
      category: null,
      kind: 'onsite',
      kindData: {
        kind: 'onsite',
        appBlockId: args.appBlockId,
        hasPage: args.hasPage ?? true,
        liveUrl: `https://${args.slug}.apps.invalid`,
      },
      iconUrl: `https://img.invalid/${args.slug}.png`,
      coverUrl: null,
    },
    appBlockId: args.appBlockId,
    connectClientId: null,
    gate: {
      row: {
        status: args.status ?? 'approved',
        kind: 'onsite',
        contentRating: args.contentRating ?? 'g',
        revisionOfId: null,
      },
      visibility: args.visibility ?? null,
      deployedAt: args.deployedAt === undefined ? at('2026-01-15T00:00:00.000Z') : args.deployedAt,
    },
  };
}

function offsiteApp(args: {
  id: string;
  slug: string;
  name: string;
  clientId: string;
  externalUrl: string | null;
  status?: string;
}): MyAppsListingCandidate {
  return {
    card: {
      id: args.id,
      slug: args.slug,
      name: args.name,
      category: null,
      kind: 'offsite',
      kindData: { kind: 'offsite', externalUrl: args.externalUrl },
      iconUrl: null,
      coverUrl: `https://img.invalid/${args.slug}-cover.png`,
    },
    appBlockId: null,
    connectClientId: args.clientId,
    gate: {
      row: {
        status: args.status ?? 'approved',
        kind: 'offsite',
        contentRating: null,
        revisionOfId: null,
      },
      visibility: null,
      deployedAt: null,
    },
  };
}

const ALPHA = pageApp({
  id: 'apl_alpha',
  slug: 'alpha-slug',
  name: 'Alpha Paint',
  appBlockId: 'blk_alpha',
});
const BRAVO = pageApp({
  id: 'apl_bravo',
  slug: 'bravo-slug',
  name: 'Bravo Tagger',
  appBlockId: 'blk_bravo',
});
const CHARLIE = offsiteApp({
  id: 'apl_charlie',
  slug: 'charlie-slug',
  name: 'Charlie Studio',
  clientId: 'cli_charlie',
  externalUrl: 'https://charlie.example.org/start',
});

describe('membership — one case per source', () => {
  it('a live scope GRANT makes a page app a member, launching in-site', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [
          { appBlockId: 'blk_alpha', grantedAt: at('2026-10-05T10:00:00.000Z'), revokedAt: null },
        ],
      },
      [ALPHA, BRAVO, CHARLIE],
      BASE_OPTS
    );
    // 🔴 THE LITERAL PIN: the whole row, every field spelled out, nothing derived from the code.
    expect(rows).toEqual([
      {
        listingId: 'apl_alpha',
        slug: 'alpha-slug',
        name: 'Alpha Paint',
        category: null,
        iconUrl: 'https://img.invalid/alpha-slug.png',
        coverUrl: null,
        kind: 'page',
        launchHref: '/apps/run/alpha-slug',
        external: false,
        lastUsedAt: at('2026-10-05T10:00:00.000Z'),
      },
    ]);
  });

  it('a live good ENTITLEMENT makes a page app a member', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        entitlements: [
          { appBlockId: 'blk_bravo', grantedAt: at('2026-10-06T11:00:00.000Z'), revokedAt: null },
        ],
      },
      [ALPHA, BRAVO, CHARLIE],
      BASE_OPTS
    );
    expect(rows.map((r) => [r.listingId, r.lastUsedAt?.toISOString()])).toEqual([
      ['apl_bravo', '2026-10-06T11:00:00.000Z'],
    ]);
  });

  it('a scope INVOCATION inside the recent window makes a page app a member; one before it does not', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        invocations: [
          { appBlockId: 'blk_alpha', invokedAt: at('2026-10-07T12:00:00.000Z') },
          // One second before the window opens.
          { appBlockId: 'blk_bravo', invokedAt: at('2026-09-30T23:59:59.000Z') },
          // A row with no App Block (an external-OAuth or dev-tunnel row) names no page app.
          { appBlockId: null, invokedAt: at('2026-10-08T00:00:00.000Z') },
        ],
      },
      [ALPHA, BRAVO, CHARLIE],
      BASE_OPTS
    );
    expect(rows.map((r) => [r.listingId, r.lastUsedAt?.toISOString()])).toEqual([
      ['apl_alpha', '2026-10-07T12:00:00.000Z'],
    ]);
  });

  it('an OAuth CONSENT makes an off-site app a member, launching its external URL in a new tab', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        consents: [{ clientId: 'cli_charlie', updatedAt: at('2026-10-09T13:00:00.000Z') }],
      },
      [ALPHA, BRAVO, CHARLIE],
      BASE_OPTS
    );
    expect(rows).toEqual([
      {
        listingId: 'apl_charlie',
        slug: 'charlie-slug',
        name: 'Charlie Studio',
        category: null,
        iconUrl: null,
        coverUrl: 'https://img.invalid/charlie-slug-cover.png',
        kind: 'offsite',
        launchHref: 'https://charlie.example.org/start',
        external: true,
        lastUsedAt: at('2026-10-09T13:00:00.000Z'),
      },
    ]);
  });

  it('a page-app signal never makes an OFF-SITE listing a member, and a consent never a page app', () => {
    // Cross-wired ids: the off-site listing's client id equals no App Block id and vice versa,
    // so membership can only come from the source that belongs to the kind.
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [
          { appBlockId: 'cli_charlie', grantedAt: at('2026-10-10T00:00:00.000Z'), revokedAt: null },
        ],
        consents: [{ clientId: 'blk_alpha', updatedAt: at('2026-10-11T00:00:00.000Z') }],
      },
      [ALPHA, CHARLIE],
      BASE_OPTS
    );
    expect(rows).toEqual([]);
  });
});

describe('dedupe — one row per listing, the most recent use wins', () => {
  it('keeps the LATEST time across three sources, whichever source carries it', () => {
    // The newest timestamp is deliberately NOT in the last source read, so "last write wins"
    // and "first write wins" both produce a different, wrong answer.
    const rows = buildMyApps(
      {
        grants: [
          { appBlockId: 'blk_alpha', grantedAt: at('2026-10-02T00:00:00.000Z'), revokedAt: null },
        ],
        entitlements: [
          { appBlockId: 'blk_alpha', grantedAt: at('2026-10-20T08:30:00.000Z'), revokedAt: null },
        ],
        invocations: [{ appBlockId: 'blk_alpha', invokedAt: at('2026-10-12T09:15:00.000Z') }],
        consents: [],
      },
      [ALPHA],
      BASE_OPTS
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].listingId).toBe('apl_alpha');
    expect(rows[0].lastUsedAt).toEqual(at('2026-10-20T08:30:00.000Z'));
  });

  it('keeps the latest invocation among many rows for the same app', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        invocations: [
          { appBlockId: 'blk_bravo', invokedAt: at('2026-10-03T00:00:00.000Z') },
          { appBlockId: 'blk_bravo', invokedAt: at('2026-10-25T17:45:00.000Z') },
          { appBlockId: 'blk_bravo', invokedAt: at('2026-10-14T06:00:00.000Z') },
        ],
      },
      [BRAVO],
      BASE_OPTS
    );
    expect(rows.map((r) => r.lastUsedAt?.toISOString())).toEqual(['2026-10-25T17:45:00.000Z']);
  });

  it('a listing that appears twice in the candidates yields one row', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [
          { appBlockId: 'blk_alpha', grantedAt: at('2026-10-04T00:00:00.000Z'), revokedAt: null },
        ],
      },
      [ALPHA, ALPHA],
      BASE_OPTS
    );
    expect(rows.map((r) => r.listingId)).toEqual(['apl_alpha']);
  });
});

describe('exclusions', () => {
  it('🔴 a REVOKED grant does not make an app a member', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [
          {
            appBlockId: 'blk_alpha',
            grantedAt: at('2026-10-05T00:00:00.000Z'),
            revokedAt: at('2026-10-06T00:00:00.000Z'),
          },
        ],
      },
      [ALPHA],
      BASE_OPTS
    );
    expect(rows).toEqual([]);
  });

  it('a revoked grant contributes no timestamp when another source keeps the app', () => {
    // The revoked grant is the NEWEST signal; if it leaked into the max, lastUsedAt would read 10-28.
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [
          {
            appBlockId: 'blk_alpha',
            grantedAt: at('2026-10-28T00:00:00.000Z'),
            revokedAt: at('2026-10-29T00:00:00.000Z'),
          },
        ],
        invocations: [{ appBlockId: 'blk_alpha', invokedAt: at('2026-10-16T00:00:00.000Z') }],
      },
      [ALPHA],
      BASE_OPTS
    );
    expect(rows.map((r) => r.lastUsedAt?.toISOString())).toEqual(['2026-10-16T00:00:00.000Z']);
  });

  it('🔴 a REVOKED entitlement does not make an app a member', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        entitlements: [
          {
            appBlockId: 'blk_bravo',
            grantedAt: at('2026-10-05T00:00:00.000Z'),
            revokedAt: at('2026-10-07T00:00:00.000Z'),
          },
        ],
      },
      [BRAVO],
      BASE_OPTS
    );
    expect(rows).toEqual([]);
  });

  it('a revoked OAuth consent is a DELETED row, so the off-site app is simply absent', () => {
    expect(buildMyApps(NO_SIGNALS, [CHARLIE], BASE_OPTS)).toEqual([]);
  });

  const LIVE_GRANT: MyAppsSignals = {
    ...NO_SIGNALS,
    grants: [
      { appBlockId: 'blk_delta', grantedAt: at('2026-10-05T00:00:00.000Z'), revokedAt: null },
    ],
  };
  const delta = (over: Partial<Parameters<typeof pageApp>[0]>) =>
    pageApp({
      id: 'apl_delta',
      slug: 'delta-slug',
      name: 'Delta Mixer',
      appBlockId: 'blk_delta',
      ...over,
    });

  it.each([
    ['unpublished (draft)', { status: 'draft' }],
    ['pending review', { status: 'pending' }],
    ['delisted / moderation-removed', { status: 'removed' }],
    ['rejected', { status: 'rejected' }],
    ['restricted by its owner to nobody (private)', { visibility: 'private' as const }],
    ['restricted to moderators, viewer on the public floor', { visibility: 'moderators' as const }],
    ['never deployed', { deployedAt: null }],
    ['mature, off a red-capable host', { contentRating: 'x' }],
    ['slot-only (no page — a model-page block)', { hasPage: false }],
  ])('drops a listing the viewer could not open in the store: %s', (_label, over) => {
    // Control: the SAME grant with the default listing IS a member, so the drop is caused by
    // the one field each case changes.
    expect(buildMyApps(LIVE_GRANT, [delta({})], BASE_OPTS)).toHaveLength(1);
    expect(buildMyApps(LIVE_GRANT, [delta(over)], BASE_OPTS)).toEqual([]);
  });

  it('a mature listing IS kept on a red-capable host (the gate reads the host, not the rating alone)', () => {
    expect(
      buildMyApps(LIVE_GRANT, [delta({ contentRating: 'x' })], { ...BASE_OPTS, redCapable: true })
    ).toHaveLength(1);
  });

  // My apps is the viewer's own launcher: it is not narrowed by their browsing level (only the
  // store's public surfaces are). An extra option is ignored, which is the point.
  it('an R app the viewer has stays in My apps whatever their browsing level', () => {
    expect(
      buildMyApps(LIVE_GRANT, [delta({ contentRating: 'r' })], {
        ...BASE_OPTS,
        redCapable: true,
        viewerBrowsingLevel: 1,
      } as BuildMyAppsOptions)
    ).toHaveLength(1);
  });

  it('an off-site-only scope drops page apps and keeps off-site ones; a dark scope drops all', () => {
    const signals: MyAppsSignals = {
      ...LIVE_GRANT,
      consents: [{ clientId: 'cli_charlie', updatedAt: at('2026-10-09T00:00:00.000Z') }],
    };
    const external = buildMyApps(signals, [delta({}), CHARLIE], {
      ...BASE_OPTS,
      scope: 'public-external',
    });
    expect(external.map((r) => r.listingId)).toEqual(['apl_charlie']);
    expect(buildMyApps(signals, [delta({}), CHARLIE], { ...BASE_OPTS, scope: 'none' })).toEqual([]);
    expect(buildMyApps(signals, [delta({}), CHARLIE], { ...BASE_OPTS, scope: undefined })).toEqual(
      []
    );
  });
});

describe('ordering — lastUsedAt desc, nulls last, then name', () => {
  it('orders by time, then puts the null-time apps last, alphabetically', () => {
    const apps = [
      pageApp({ id: 'apl_p1', slug: 'p1-slug', name: 'Mango', appBlockId: 'blk_p1' }),
      pageApp({ id: 'apl_p2', slug: 'p2-slug', name: 'Kiwi', appBlockId: 'blk_p2' }),
      pageApp({ id: 'apl_p3', slug: 'p3-slug', name: 'Zucchini', appBlockId: 'blk_p3' }),
      pageApp({ id: 'apl_p4', slug: 'p4-slug', name: 'Apricot', appBlockId: 'blk_p4' }),
      pageApp({ id: 'apl_p5', slug: 'p5-slug', name: 'Lime', appBlockId: 'blk_p5' }),
    ];
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [
          { appBlockId: 'blk_p1', grantedAt: at('2026-10-11T00:00:00.000Z'), revokedAt: null },
          { appBlockId: 'blk_p2', grantedAt: at('2026-10-21T00:00:00.000Z'), revokedAt: null },
          { appBlockId: 'blk_p3', grantedAt: null, revokedAt: null },
          { appBlockId: 'blk_p4', grantedAt: null, revokedAt: null },
          { appBlockId: 'blk_p5', grantedAt: at('2026-10-17T00:00:00.000Z'), revokedAt: null },
        ],
      },
      apps,
      BASE_OPTS
    );
    expect(rows.map((r) => r.name)).toEqual(['Kiwi', 'Lime', 'Mango', 'Apricot', 'Zucchini']);
  });

  it('breaks an exact time tie by name', () => {
    const tie = at('2026-10-19T00:00:00.000Z');
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [{ appBlockId: 'blk_alpha', grantedAt: tie, revokedAt: null }],
        consents: [{ clientId: 'cli_charlie', updatedAt: tie }],
        entitlements: [{ appBlockId: 'blk_bravo', grantedAt: tie, revokedAt: null }],
      },
      // Candidate order is the REVERSE of name order, so an unsorted pass-through fails.
      [CHARLIE, BRAVO, ALPHA],
      BASE_OPTS
    );
    expect(rows.map((r) => r.name)).toEqual(['Alpha Paint', 'Bravo Tagger', 'Charlie Studio']);
  });
});

describe('launch href — page vs off-site', () => {
  it('an off-site app with no usable external URL launches its store page, in-site', () => {
    const noUrl = offsiteApp({
      id: 'apl_echo',
      slug: 'echo-slug',
      name: 'Echo Notes',
      clientId: 'cli_echo',
      externalUrl: null,
    });
    const [row] = buildMyApps(
      {
        ...NO_SIGNALS,
        consents: [{ clientId: 'cli_echo', updatedAt: at('2026-10-09T00:00:00.000Z') }],
      },
      [noUrl],
      BASE_OPTS
    );
    expect(row.launchHref).toBe('/apps/store-preview/echo-slug');
    expect(row.external).toBe(false);
  });

  it('a page app launches its store page when the viewer cannot open pages', () => {
    const [row] = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [
          { appBlockId: 'blk_alpha', grantedAt: at('2026-10-05T00:00:00.000Z'), revokedAt: null },
        ],
      },
      [ALPHA],
      { ...BASE_OPTS, canOpenPage: false }
    );
    expect(row.kind).toBe('page');
    expect(row.launchHref).toBe('/apps/store-preview/alpha-slug');
    expect(row.external).toBe(false);
  });

  it('caps the list at the limit, keeping the most recent', () => {
    const rows = buildMyApps(
      {
        ...NO_SIGNALS,
        grants: [
          { appBlockId: 'blk_alpha', grantedAt: at('2026-10-02T00:00:00.000Z'), revokedAt: null },
          { appBlockId: 'blk_bravo', grantedAt: at('2026-10-22T00:00:00.000Z'), revokedAt: null },
        ],
      },
      [ALPHA, BRAVO],
      { ...BASE_OPTS, limit: 1 }
    );
    expect(rows.map((r) => r.listingId)).toEqual(['apl_bravo']);
  });
});

describe('"Remove from My apps" is applied BEFORE the row cap', () => {
  // 130 page apps, each used at a distinct minute: app i (0..129) at BASE + i min, so a
  // higher i is more recent. 130 overshoots the cap (100), and 17 hides leave 113 visible —
  // still past it, so the cap really does cut.
  const COUNT = 130;
  const BASE_MS = Date.parse('2026-10-03T00:00:00.000Z');
  const pad = (i: number) => String(i).padStart(3, '0');
  const usedAtMs = (i: number) => BASE_MS + i * 60_000;
  const many = Array.from({ length: COUNT }, (_, i) =>
    pageApp({
      id: `apl_app_${pad(i)}`,
      slug: `app-${pad(i)}`,
      name: `App ${pad(i)}`,
      appBlockId: `blk_${pad(i)}`,
    })
  );
  const manySignals: MyAppsSignals = {
    ...NO_SIGNALS,
    grants: Array.from({ length: COUNT }, (_, i) => ({
      appBlockId: `blk_${pad(i)}`,
      grantedAt: new Date(usedAtMs(i)),
      revokedAt: null,
    })),
  };
  // 15 hides inside the old top 100 (i >= 30), 2 below it — each 37s AFTER that app's use,
  // so every one is in force.
  const HIDDEN_IDX = [129, 127, 122, 118, 111, 104, 99, 93, 86, 77, 68, 59, 47, 38, 31, 5, 3];
  const hidden = Object.fromEntries(
    HIDDEN_IDX.map((i) => [`app-${pad(i)}`, new Date(usedAtMs(i) + 37_000).toISOString()])
  );

  it('🔴 a removed app takes no slot: exactly the cap, filled by the apps past the old cutoff', () => {
    const { apps, removedCount } = buildMyAppsHome(manySignals, many, { ...BASE_OPTS, hidden });
    expect(MY_APPS_MAX_ROWS).toBe(100);
    expect(apps).toHaveLength(100);
    expect(removedCount).toBe(17);
    const ids = apps.map((r) => r.listingId);
    // Most recent visible first; no hidden app anywhere.
    expect(ids[0]).toBe('apl_app_128');
    for (const i of HIDDEN_IDX) expect(ids).not.toContain(`apl_app_${pad(i)}`);
    // Without the fix the list ended at app 030; now the 15 apps below it fill the freed
    // slots (029..015), and app 014 is the first one left out.
    expect(ids.slice(-15)).toEqual(Array.from({ length: 15 }, (_, k) => `apl_app_${pad(29 - k)}`));
    expect(ids).not.toContain('apl_app_014');
  });

  it('no hidden map (or an empty one) → the plain top 100, nothing removed', () => {
    const plain = buildMyAppsHome(manySignals, many, BASE_OPTS);
    const empty = buildMyAppsHome(manySignals, many, { ...BASE_OPTS, hidden: {} });
    const expected = Array.from({ length: 100 }, (_, k) => `apl_app_${pad(129 - k)}`);
    expect(plain.apps.map((r) => r.listingId)).toEqual(expected);
    expect(plain.removedCount).toBe(0);
    expect(empty).toEqual(plain);
  });

  it('🔴 hidden, then used LATER → shown (the hide is older than the last use)', () => {
    const signals: MyAppsSignals = {
      ...NO_SIGNALS,
      grants: [
        { appBlockId: 'blk_alpha', grantedAt: at('2026-10-14T09:00:00.000Z'), revokedAt: null },
        { appBlockId: 'blk_bravo', grantedAt: at('2026-10-11T06:00:00.000Z'), revokedAt: null },
      ],
    };
    const { apps, removedCount } = buildMyAppsHome(signals, [ALPHA, BRAVO], {
      ...BASE_OPTS,
      // alpha hidden before its last use; bravo hidden after it.
      hidden: {
        'alpha-slug': '2026-10-12T03:00:00.000Z',
        'bravo-slug': '2026-10-13T05:00:00.000Z',
      },
    });
    expect(apps.map((r) => r.listingId)).toEqual(['apl_alpha']);
    expect(removedCount).toBe(1);
  });

  it('the boundary follows the shared predicate: used AT hiddenAt stays hidden, 1ms after shows', () => {
    const signals: MyAppsSignals = {
      ...NO_SIGNALS,
      grants: [
        { appBlockId: 'blk_alpha', grantedAt: at('2026-10-16T08:00:00.000Z'), revokedAt: null },
        { appBlockId: 'blk_bravo', grantedAt: at('2026-10-15T07:00:00.001Z'), revokedAt: null },
      ],
    };
    const { apps, removedCount } = buildMyAppsHome(signals, [ALPHA, BRAVO], {
      ...BASE_OPTS,
      hidden: {
        'alpha-slug': '2026-10-16T08:00:00.000Z',
        'bravo-slug': '2026-10-15T07:00:00.000Z',
      },
    });
    expect(apps.map((r) => r.listingId)).toEqual(['apl_bravo']);
    expect(removedCount).toBe(1);
  });

  it('a hide for a slug no row has, or an unparseable hide, removes nothing', () => {
    const signals: MyAppsSignals = {
      ...NO_SIGNALS,
      grants: [
        { appBlockId: 'blk_alpha', grantedAt: at('2026-10-17T02:00:00.000Z'), revokedAt: null },
      ],
    };
    const { apps, removedCount } = buildMyAppsHome(signals, [ALPHA], {
      ...BASE_OPTS,
      hidden: { 'gone-slug': '2026-10-18T00:00:00.000Z', 'alpha-slug': 'not a date' },
    });
    expect(apps.map((r) => r.listingId)).toEqual(['apl_alpha']);
    expect(removedCount).toBe(0);
  });
});
