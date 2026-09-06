import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Store Listings (W13) — P2a unified store READ PATH tests.
 *
 * Covers the public-allowlist projections + query building for
 * `app-listing.service` (the `AppListing`-backed twin of the AppBlock
 * marketplace read path). We do NOT hit a DB — `dbRead.$queryRaw` (the keyset
 * id page) and `dbRead.appListing.findMany/findFirst` (the hydration) are mocked
 * so we can assert both the projected wire SHAPE (no internal-field leaks) and
 * the SQL the service builds (approved-only, kind/category filters, sort +
 * keyset). `getEdgeUrl` is mocked to identity so URL fields echo the stored key.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    // App Listing COLLABORATORS: `getAppListingDetail` now hydrates the PUBLIC BYLINE
    // (accepted + displayed collaborators) alongside the listing. Both reads go through
    // `safeCollaboratorQuery`, which swallows ONLY the missing-TABLE error — so an
    // absent mock surfaces as a TypeError instead of being silently absorbed. Empty
    // here: these suites assert the pre-collaborator projection, which must be
    // byte-identical when an app has no seats.
    appCollaborator: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appListing: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
// getEdgeUrl → identity so URL fields assert against the stored key.
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600 } }));
// queryCache → passthrough to the mocked $queryRaw (no Redis in unit tests).
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      mockDbRead.$queryRaw(sql),
}));

import fs from 'fs';
import path from 'path';
import {
  decodeListingCursor,
  encodeListingCursor,
  getListingDetail,
  getListingPreviewForReview,
  listAvailableListings,
  listingHydrateSelect,
  moderationStatusWhere,
  projectListingCard,
  projectListingDetail,
  recommendRollup,
} from '../app-listing.service';
import { listAppListingsSchema } from '~/server/schema/blocks/app-listing-read.schema';

const SEP = String.fromCharCode(31);

/** Reconstruct the SQL string Prisma received (single Prisma.Sql arg). */
function capturedSql(): string {
  const last = mockDbRead.$queryRaw.mock.calls.at(-1);
  const first = last?.[0] as { sql?: unknown } | undefined;
  return first && typeof first.sql === 'string' ? first.sql : '';
}

/** The bound parameter values of the last $queryRaw call. */
function capturedValues(): unknown[] {
  const last = mockDbRead.$queryRaw.mock.calls.at(-1);
  const first = last?.[0] as { values?: unknown[] } | undefined;
  return first?.values ?? [];
}

/** A fully-hydrated onsite listing row (as `listingHydrateSelect` returns). */
function hydratedRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_1',
    // Integer surrogate (CommentsV2 thread key) — projected into the detail DTO only.
    serialId: 101,
    kind: 'onsite',
    slug: 'cool-app',
    name: 'Cool App',
    tagline: 'Does cool things',
    description: '# Cool app\n\nbody',
    category: 'utility',
    contentRating: 'pg',
    externalUrl: null,
    connectClientId: null,
    appBlockId: 'ab_1',
    icon: { url: 'icon-key' },
    cover: { url: 'cover-key' },
    user: { id: 7, username: 'dev', image: 'avatar-key' },
    metric: { thumbsUpCount: 9, thumbsDownCount: 1 },
    // `updatedAt` is a NOT-NULL Prisma column on every real row; the detail
    // projection reads it for the header's "Updated:" meta line. Fixed value so
    // the projection's ISO output is deterministic.
    updatedAt: new Date('2026-03-04T05:06:07.000Z'),
    appBlock: {
      // DEPLOY-GATE: a deployed onsite block (non-null timestamp) so the detail
      // read returns its projection. The dedicated deploy-gate suite covers the
      // never-deployed (NULL → unavailable) onsite case.
      currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
      manifest: {
        name: 'Cool App',
        page: { path: '/run' },
        // internal fields that must NEVER reach a public DTO:
        trustTier: 'internal',
        iframe: { src: 'https://cool.internal.example/', sandbox: 'allow-scripts' },
        scopes: ['ai:write:budgeted'],
        settings: { apiKey: 'super-secret' },
      },
    },
    screenshots: [{ caption: 'first shot', image: { url: 'shot-0' } }],
    ...over,
  };
}

describe('recommendRollup', () => {
  it('computes counts + pct from the metric rollup', () => {
    expect(recommendRollup({ thumbsUpCount: 9, thumbsDownCount: 1 })).toEqual({
      recommendedCount: 9,
      notRecommendedCount: 1,
      recommendPct: 0.9,
    });
  });

  it('returns 0/0/null when the metric row is absent (P5-populated)', () => {
    expect(recommendRollup(null)).toEqual({
      recommendedCount: 0,
      notRecommendedCount: 0,
      recommendPct: null,
    });
    expect(recommendRollup(undefined)).toEqual({
      recommendedCount: 0,
      notRecommendedCount: 0,
      recommendPct: null,
    });
  });

  it('recommendPct is null (not 0) when there are zero reviews', () => {
    expect(recommendRollup({ thumbsUpCount: 0, thumbsDownCount: 0 }).recommendPct).toBeNull();
  });
});

/**
 * 🔴 `resolveOffsiteSubKind` is DELETED. It returned `connectClientId ? 'connect'
 * : 'external-link'`, and that derived value was the whole off-site display
 * taxonomy. Its coverage moves to the two projections below, which now assert
 * the ABSENCE of a `subKind` key rather than its value (the "key set is exactly
 * …" cases), plus the truthiness case its deletion could have silently changed.
 */

describe('cursor encode/decode', () => {
  it('round-trips a 2-field cursor (non-top-rated sorts)', () => {
    const c = encodeListingCursor('0000000005', 'apl_9');
    expect(decodeListingCursor(c)).toEqual({
      cursorSortKey: '0000000005',
      cursorId: 'apl_9',
      cursorMean: null,
    });
  });

  it('round-trips a 3-field cursor with a pinned mean (top-rated)', () => {
    const c = encodeListingCursor('000000900', 'apl_2', 0.72);
    expect(decodeListingCursor(c)).toEqual({
      cursorSortKey: '000000900',
      cursorId: 'apl_2',
      cursorMean: 0.72,
    });
  });

  it('a malformed / empty cursor decodes to first-page (fail-open)', () => {
    expect(decodeListingCursor(undefined)).toEqual({
      cursorSortKey: null,
      cursorId: null,
      cursorMean: null,
    });
    expect(decodeListingCursor('not a real cursor!!!')).toEqual({
      cursorSortKey: null,
      cursorId: null,
      cursorMean: null,
    });
  });

  it('drops an out-of-[0,1] mean (crafted overflow guard) but keeps the keyset', () => {
    // A mean like 1e300 would flow into `round(score * SCALE)::bigint` and
    // overflow int8 (→ Postgres "bigint out of range" → 500). It is dropped to
    // null so the caller falls back to the freshly-computed global mean.
    const huge = encodeListingCursor('000000900', 'apl_2', 1e300);
    expect(decodeListingCursor(huge)).toEqual({
      cursorSortKey: '000000900',
      cursorId: 'apl_2',
      cursorMean: null,
    });
    // Large-negative mean, encoded raw (also out of range → dropped).
    const neg = Buffer.from(`000000900${SEP}apl_2${SEP}-1e300`, 'utf8').toString('base64url');
    expect(decodeListingCursor(neg).cursorMean).toBeNull();
    // A boundary in-range mean (0 and 1) is KEPT.
    expect(decodeListingCursor(encodeListingCursor('k', 'id', 0)).cursorMean).toBe(0);
    expect(decodeListingCursor(encodeListingCursor('k', 'id', 1)).cursorMean).toBe(1);
  });
});

describe('projectListingCard — public allowlist (no internal leaks)', () => {
  it('projects the exact public card allowlist', () => {
    const card = projectListingCard(hydratedRow() as never);
    expect(Object.keys(card).sort()).toEqual(
      [
        'category',
        'contentRating',
        'coverUrl',
        'creator',
        'iconUrl',
        'id',
        // 🔴 DELIBERATE ADDITION, not an incidental one. The author-declared beta LABEL is
        // on the card because a badge is what a grid tile can carry honestly. Its
        // free-text companion `betaMessage` is NOT — the detail allowlist below asserts
        // that field's presence and this list asserts its absence, which is the pair that
        // pins the split.
        'isBeta',
        'kind',
        'kindData',
        'name',
        // 🔴 The play count is a CARD field. Unlike `installCount` (detail-only), the
        // whole point of this number is to tell a browsing user how used an app is
        // BEFORE they click into it, so the grid tile is its primary surface. It is
        // `number | null`, and the null-vs-zero suite below pins which is which.
        'openCount',
        'recommend',
        'reviewCount',
        'slug',
        'tagline',
      ].sort()
    );
    expect(card).not.toHaveProperty('status');
    expect(card).not.toHaveProperty('description'); // detail-only
    // The beta NOTE is detail-only — a card must not carry unreviewed author prose.
    expect(card).not.toHaveProperty('betaMessage');
  });

  it('never leaks internal AppBlock manifest fields onto the card', () => {
    const card = projectListingCard(hydratedRow() as never);
    const serialized = JSON.stringify(card);
    for (const secret of ['trustTier', 'internal.example', 'super-secret', 'allow-scripts']) {
      expect(serialized, `card leaked "${secret}"`).not.toContain(secret);
    }
  });

  it('projects icon/cover URLs, creator chip, recommend rollup + reviewCount', () => {
    const card = projectListingCard(hydratedRow() as never);
    expect(card.iconUrl).toBe('icon-key');
    expect(card.coverUrl).toBe('cover-key');
    expect(card.creator).toEqual({ id: 7, username: 'dev', image: 'avatar-key' });
    expect(card.recommend).toEqual({
      recommendedCount: 9,
      notRecommendedCount: 1,
      recommendPct: 0.9,
    });
    expect(card.reviewCount).toBe(10);
  });

  it('onsite kindData carries appBlockId + hasPage (Open) + the computed liveUrl when the manifest declares a page', () => {
    const card = projectListingCard(hydratedRow() as never);
    expect(card.kindData).toEqual({
      kind: 'onsite',
      appBlockId: 'ab_1',
      hasPage: true,
      liveUrl: 'https://cool-app.civit.ai',
    });
  });

  it('onsite hasPage=false (Install) when the manifest declares no page (liveUrl still present)', () => {
    const row = hydratedRow({ appBlock: { manifest: { name: 'X', targets: [] } } });
    const card = projectListingCard(row as never);
    expect(card.kindData).toEqual({
      kind: 'onsite',
      appBlockId: 'ab_1',
      hasPage: false,
      liveUrl: 'https://cool-app.civit.ai',
    });
  });

  it('onsite card liveUrl is `https://<slug>.<APPS_DOMAIN>` for the seeded slug', () => {
    const row = hydratedRow({ slug: 'my-neat-app' });
    const card = projectListingCard(row as never);
    expect(card.kindData).toMatchObject({
      kind: 'onsite',
      liveUrl: 'https://my-neat-app.civit.ai',
    });
  });

  it('PARITY GUARD: onsite card liveUrl === detail liveUrl for the same listing (anti-drift)', () => {
    // Both projections must compose liveUrl the SAME way (shared helper). If a
    // future change alters one derivation and not the other, this fails.
    const row = hydratedRow({ slug: 'parity-app' });
    const card = projectListingCard(row as never);
    const detail = projectListingDetail(row as never);
    const cardKind = card.kindData as { kind: 'onsite'; liveUrl: string };
    const detailKind = detail.kindData as { kind: 'onsite'; liveUrl: string };
    expect(cardKind.liveUrl).toBe('https://parity-app.civit.ai');
    expect(cardKind.liveUrl).toBe(detailKind.liveUrl);
  });

  it('coverUrl falls back to the first screenshot when there is no cover', () => {
    const row = hydratedRow({ cover: null });
    expect(projectListingCard(row as never).coverUrl).toBe('shot-0');
  });

  it('coverUrl is null when there is no cover and no screenshot', () => {
    const row = hydratedRow({ cover: null, screenshots: [] });
    expect(projectListingCard(row as never).coverUrl).toBeNull();
  });

  it('recommend rollup is 0/0/null when the metric row is absent', () => {
    const row = hydratedRow({ metric: null });
    const card = projectListingCard(row as never);
    expect(card.recommend).toEqual({
      recommendedCount: 0,
      notRecommendedCount: 0,
      recommendPct: null,
    });
    expect(card.reviewCount).toBe(0);
  });

  it('offsite card with an OAuth client and no URL: NO subKind, externalUrl passthrough', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: 'oauth_abc',
      externalUrl: null,
    });
    const card = projectListingCard(row as never);
    expect(card.kind).toBe('offsite');
    expect(card.kindData).toEqual({ kind: 'offsite', externalUrl: null });
  });

  /**
   * 🔴 THE GRANDFATHERED LISTING — the load-bearing case for this change.
   *
   * Measured in production 2026-08-19: of five off-site listings, exactly ONE
   * approved row has `connect_client_id IS NULL`. Every listing minted since
   * then goes through `ExternalSubmitForm`, whose create flow REQUIRES a
   * `connectClientId` — so this row is the only live inhabitant of what used to
   * be the `external-link` sub-kind, and it is the shape most at risk of
   * rendering blank / "unknown" / falling through a deleted branch.
   *
   * It must project to the SAME `kindData` shape as an OAuth-connected row: one
   * kind, no sub-kind key, its URL intact.
   */
  it('🔴 GRANDFATHERED offsite card (connectClientId null): same shape, no subKind, URL intact', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: null,
      externalUrl: 'https://grandfathered.example/app',
    });
    const card = projectListingCard(row as never);
    expect(card.kindData).toEqual({
      kind: 'offsite',
      externalUrl: 'https://grandfathered.example/app',
    });
  });

  /**
   * 🔴 The collapse, stated as an EQUALITY rather than as two labels. Two rows
   * differing ONLY in `connectClientId` — the exact field the deleted sub-kind
   * was derived from — must produce byte-identical card kindData. A revert
   * reintroducing `subKind` fails HERE, on this assertion, because the two
   * objects would then differ by `'connect'` vs `'external-link'`.
   *
   * The URL is deliberately shared and non-default so the equality cannot be
   * satisfied by two empty objects.
   */
  it('🔴 the grandfathered row and an OAuth-connected row produce IDENTICAL card kindData', () => {
    const shared = {
      kind: 'offsite' as const,
      appBlockId: null,
      appBlock: null,
      externalUrl: 'https://same-target.example/app',
    };
    const connected = projectListingCard(
      hydratedRow({ ...shared, connectClientId: 'oauth_abc' }) as never
    );
    const grandfathered = projectListingCard(
      hydratedRow({ ...shared, connectClientId: null }) as never
    );
    expect(connected.kindData).toEqual(grandfathered.kindData);
    // …and it is the collapsed shape, not merely "equal to each other".
    expect(connected.kindData).toEqual({
      kind: 'offsite',
      externalUrl: 'https://same-target.example/app',
    });
  });

  it('🔴 the offsite card kindData has NO subKind key at all (not merely a falsy one)', () => {
    for (const connectClientId of ['oauth_abc', null]) {
      const card = projectListingCard(
        hydratedRow({
          kind: 'offsite',
          appBlockId: null,
          appBlock: null,
          connectClientId,
          externalUrl: 'https://keys.example/app',
        }) as never
      );
      expect(Object.keys(card.kindData).sort(), String(connectClientId)).toEqual([
        'externalUrl',
        'kind',
      ]);
    }
  });

  it('a vanished owner yields a null creator chip (no crash)', () => {
    const row = hydratedRow({ user: null });
    expect(projectListingCard(row as never).creator).toBeNull();
  });
});

describe('projectListingDetail — public allowlist + gallery', () => {
  it('projects the detail allowlist incl. description + screenshots', () => {
    const detail = projectListingDetail(hydratedRow() as never);
    expect(Object.keys(detail).sort()).toEqual(
      [
        'category',
        // App Listing COLLABORATORS: the PUBLIC BYLINE (accepted + displayed seats),
        // projected through the SAME {id, username, image} allowlist as `creator`.
        // Empty here — this row has no seats — but the KEY must be present, so a
        // consumer never has to write `?? []`.
        'collaborators',
        'contentRating',
        'coverUrl',
        'creator',
        'description',
        'iconUrl',
        'id',
        // 🔴 The two fields added for the store-detail header. Both are in the
        // ALLOWLIST deliberately (see their docstrings on `ListingDetail`):
        // `installCount` is the very column the public `popular` sort already orders
        // every approved listing by, and `updatedAt` is the direct analogue of the
        // model page's public `Updated: <date>` line.
        'installCount',
        // 🔴 The author-declared beta pair. `isBeta` is also on the CARD (a badge); the
        // free-text `betaMessage` is DETAIL-ONLY, for the same reason `sourceRepoUrl` is —
        // a grid tile has no room for a sentence. The card allowlist above asserts the
        // note's absence.
        'betaMessage',
        'isBeta',
        'kind',
        'kindData',
        'name',
        'recommend',
        'reviewCount',
        'screenshots',
        'serialId',
        'slug',
        // 🔴 DETAIL-ONLY BY DECISION — the card allowlist above asserts its ABSENCE.
        // The public source-repo link is an outbound link, and a store grid tile has
        // no room for the context that makes clicking one safe. See its docstring on
        // `ListingDetail`.
        'sourceRepoUrl',
        'tagline',
        'updatedAt',
      ].sort()
    );
    expect(detail).not.toHaveProperty('status');
    expect(detail.description).toBe('# Cool app\n\nbody');
    // The integer surrogate is surfaced for the CommentsV2 thread key.
    expect(detail.serialId).toBe(101);
    // 🔴 ISO-8601 STRING, not a Date. This DTO also crosses the transformer-less
    // public REST boundary, where a Date would serialise inconsistently. Pinned as a
    // literal so a "just pass the Date through" change fails here.
    expect(detail.updatedAt).toBe('2026-03-04T05:06:07.000Z');
    expect(typeof detail.updatedAt).toBe('string');
    // `hydratedRow()`'s metric carries no installCount → the COALESCE-to-0 branch.
    expect(detail.installCount).toBe(0);
  });

  it('installCount is read from the metric rollup, and 0 when there is no metric row', () => {
    // Positive control FIRST: the field CAN carry a non-zero value, so the zero
    // asserted below is a real zero and not a projection wired to a constant.
    // 4213 is pairwise-distinct from every other count in this file and from the
    // `0` the null branch returns.
    const withInstalls = projectListingDetail(
      hydratedRow({ metric: { thumbsUpCount: 9, thumbsDownCount: 1, installCount: 4213 } }) as never
    );
    expect(withInstalls.installCount).toBe(4213);

    const noMetric = projectListingDetail(hydratedRow({ metric: null }) as never);
    expect(noMetric.installCount).toBe(0);
  });

  it('onsite detail kindData carries appBlockId, hasPage + the computed liveUrl', () => {
    const detail = projectListingDetail(hydratedRow() as never);
    expect(detail.kindData).toEqual({
      kind: 'onsite',
      appBlockId: 'ab_1',
      hasPage: true,
      liveUrl: 'https://cool-app.civit.ai',
    });
  });

  it('offsite detail exposes the PUBLIC connectClientId (never a secret), and NO subKind', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: 'oauth_abc',
      externalUrl: null,
    });
    const detail = projectListingDetail(row as never);
    expect(detail.kindData).toEqual({
      kind: 'offsite',
      externalUrl: null,
      connectClientId: 'oauth_abc',
    });
  });

  /**
   * 🔴 The grandfathered listing at the DETAIL projection. `connectClientId`
   * stays on the wire as a CAPABILITY (two surfaces still read it — the
   * account-access disclosure and the no-destination CTA fallback); what is gone
   * is the derived `subKind`.
   */
  it('🔴 GRANDFATHERED offsite detail (connectClientId null): null client, URL intact, no subKind', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: null,
      externalUrl: 'https://grandfathered.example/app',
    });
    const detail = projectListingDetail(row as never);
    expect(detail.kindData).toEqual({
      kind: 'offsite',
      externalUrl: 'https://grandfathered.example/app',
      connectClientId: null,
    });
  });

  it('🔴 the offsite detail kindData key set is exactly kind/externalUrl/connectClientId', () => {
    for (const connectClientId of ['oauth_abc', null]) {
      const detail = projectListingDetail(
        hydratedRow({
          kind: 'offsite',
          appBlockId: null,
          appBlock: null,
          connectClientId,
          externalUrl: 'https://keys.example/app',
        }) as never
      );
      expect(Object.keys(detail.kindData).sort(), String(connectClientId)).toEqual([
        'connectClientId',
        'externalUrl',
        'kind',
      ]);
    }
  });

  /**
   * 🔴 `|| null`, NOT `?? null`. The deleted `resolveOffsiteSubKind` used a
   * TRUTHINESS test, and the old projection wrote
   * `subKind === 'connect' ? connectClientId ?? null : null` — so an
   * empty-string client id reached the wire as `null`. Preserving that is what
   * makes this collapse behaviour-neutral rather than merely type-clean; `??`
   * would newly emit `''`, and every consumer of this field is a
   * "does this app connect to your account?" truthiness check.
   */
  it('🔴 an empty-string connectClientId still projects as null (truthiness, not nullish)', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: '',
      externalUrl: 'https://empty-client.example/app',
    });
    const detail = projectListingDetail(row as never);
    expect(detail.kindData).toEqual({
      kind: 'offsite',
      externalUrl: 'https://empty-client.example/app',
      connectClientId: null,
    });
  });

  it('the gallery excludes screenshots whose backing Image is gone (null image)', () => {
    const row = hydratedRow({
      screenshots: [
        { caption: 'a', image: { url: 's0' } },
        { caption: 'b', image: null },
        { caption: 'c', image: { url: 's2' } },
      ],
    });
    const detail = projectListingDetail(row as never);
    expect(detail.screenshots).toEqual([
      { url: 's0', caption: 'a' },
      { url: 's2', caption: 'c' },
    ]);
  });

  it('never leaks internal manifest fields onto the detail', () => {
    const serialized = JSON.stringify(projectListingDetail(hydratedRow() as never));
    for (const secret of ['trustTier', 'internal.example', 'super-secret']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('listAvailableListings — query building + pagination', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.appListing.findMany.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockDbRead.appListing.findMany.mockResolvedValue([]);
  });

  it('SQL hard-filters status = approved (draft/pending/rejected never returned)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(capturedSql()).toMatch(/al\.status\s*=\s*'approved'/);
  });

  it('SQL excludes SHADOW revision drafts (revision_of_id IS NULL) — defense in depth', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(capturedSql()).toMatch(/al\.revision_of_id\s+IS\s+NULL/i);
  });

  it('kind filter binds the requested kind (onsite)', async () => {
    await listAvailableListings({ kind: 'onsite', sort: 'newest', limit: 20 });
    expect(capturedSql()).toMatch(/al\.kind\s*=/);
    expect(capturedValues()).toContain('onsite');
  });

  it("kind='all' does not bind a kind (the filter is a no-op)", async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(capturedValues()).not.toContain('onsite');
    expect(capturedValues()).not.toContain('offsite');
  });

  it('category filter binds the requested category', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', category: 'games', limit: 20 });
    expect(capturedSql()).toMatch(/al\.category\s*=/);
    expect(capturedValues()).toContain('games');
  });

  it('maturity gate hides r/x when not red-capable', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 }, { redCapable: false });
    expect(capturedSql()).toMatch(/content_rating.*NOT IN \('r', 'x'\)/i);
  });

  it('maturity gate is a no-op (TRUE) on a red-capable host', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 }, { redCapable: true });
    expect(capturedSql()).not.toMatch(/content_rating.*NOT IN/i);
  });

  it('sort=popular orders by install count DESC (no Bayesian fragment)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'popular', limit: 20 });
    const sql = capturedSql();
    expect(sql).toMatch(/lpad\(COALESCE\(m\.install_count/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
    expect(sql).not.toMatch(/lpad\(round\(/i);
  });

  it('sort=newest orders by created_at DESC', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    const sql = capturedSql();
    expect(sql).toMatch(/to_char\(al\.created_at/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
  });

  it('sort=name orders by LOWER(name) ASC and resumes the keyset with `>`', async () => {
    await listAvailableListings({ kind: 'all', sort: 'name', limit: 20 });
    const sql = capturedSql();
    expect(sql).toMatch(/LOWER\(al\.name\)/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+ASC/i);
    expect(sql).toMatch(/,\s*al\.id\)\s*>\s*\(/);
  });

  it('sort=top-rated emits the Bayesian recommend key in SELECT + keyset WHERE (no drift)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'top-rated', limit: 20 });
    const sql = capturedSql();
    // The Bayesian fragment appears in the SELECT (AS sort_key) AND the keyset.
    const occurrences = sql.match(/lpad\(round\(/gi)?.length ?? 0;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
    expect(sql).toMatch(/,\s*al\.id\)\s*<\s*\(/); // DESC keyset resumes with `<`
    // Regression guard: lpad length args MUST be cast to ::int (bigint has no overload).
    expect(sql).toMatch(/lpad\(round\([\s\S]*?::int,\s*'0'\)/i);
  });

  it('returns both kinds and preserves the keyset order across hydration', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { id: 'apl_a', sort_key: 'k2' },
      { id: 'apl_b', sort_key: 'k1' },
    ]);
    // findMany returns the rows OUT OF ORDER — the service must re-apply the id order.
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      hydratedRow({
        id: 'apl_b',
        kind: 'offsite',
        appBlockId: null,
        appBlock: null,
        connectClientId: 'oc_1',
        slug: 'b-app',
      }),
      hydratedRow({ id: 'apl_a', kind: 'onsite', slug: 'a-app' }),
    ]);
    const { items } = await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(items.map((i) => i.id)).toEqual(['apl_a', 'apl_b']);
    expect(items.map((i) => i.kind)).toEqual(['onsite', 'offsite']);
  });

  it('emits nextCursor only when a full page+1 is returned (pagination contract)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { id: 'apl_0', sort_key: '20260101000000000000' },
      { id: 'apl_1', sort_key: '20260101000000000001' },
      { id: 'apl_2', sort_key: '20260101000000000002' }, // the +1 (dropped)
    ]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      hydratedRow({ id: 'apl_0', slug: 's0' }),
      hydratedRow({ id: 'apl_1', slug: 's1' }),
    ]);
    const { items, nextCursor } = await listAvailableListings({
      kind: 'all',
      sort: 'newest',
      limit: 2,
    });
    expect(items).toHaveLength(2);
    expect(nextCursor).toBeDefined();
    // The cursor is the LAST returned row's (sortKey, id) — carries the sort key,
    // not just the id, so a paged scan over tied sort values is stable.
    const decoded = Buffer.from(nextCursor as string, 'base64url').toString('utf8');
    expect(decoded).toBe(`20260101000000000001${SEP}apl_1`);
  });

  it('no nextCursor when the result fits in one page', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 'apl_0', sort_key: 'k0' }]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([hydratedRow({ id: 'apl_0' })]);
    const { nextCursor } = await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(nextCursor).toBeUndefined();
  });

  it('sort=top-rated page 1 reads + PINS the global recommend mean into nextCursor', async () => {
    // Call 1 = getGlobalRecommendMean (via queryCache → $queryRaw): mean 0.8.
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ mean: 0.8 }]);
    // Call 2 = the id page (limit+1 so nextCursor is emitted).
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { id: 'apl_0', sort_key: '000000800' },
      { id: 'apl_1', sort_key: '000000790' },
      { id: 'apl_2', sort_key: '000000780' },
    ]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      hydratedRow({ id: 'apl_0' }),
      hydratedRow({ id: 'apl_1' }),
    ]);
    const { nextCursor } = await listAvailableListings({
      kind: 'all',
      sort: 'top-rated',
      limit: 2,
    });
    const decoded = Buffer.from(nextCursor as string, 'base64url').toString('utf8');
    expect(decoded).toBe(`000000790${SEP}apl_1${SEP}0.8`);
  });

  it('sort=top-rated with a pinned-mean cursor REUSES it (no global-mean re-read)', async () => {
    const cursor = Buffer.from(`000000250${SEP}apl_5${SEP}0.25`, 'utf8').toString('base64url');
    // ONLY the id-page query is queued — if the service re-read the mean it would
    // consume this and the id page would get [].
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 'apl_9', sort_key: '000000240' }]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([hydratedRow({ id: 'apl_9' })]);
    const { items } = await listAvailableListings({
      kind: 'all',
      sort: 'top-rated',
      cursor,
      limit: 20,
    });
    expect(items).toHaveLength(1);
    // Exactly ONE $queryRaw (the id page) — the mean re-read was skipped.
    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
    // The pinned mean 0.25 is bound into the Bayesian key (C*m term).
    expect(capturedValues()).toContain(0.25);
  });

  it('sort=top-rated with a crafted out-of-range mean cursor does NOT 500', async () => {
    // The mean is dropped by decode (clamp), so the service re-reads the global
    // mean (call 1) then runs the id page (call 2) — nothing overflows the bigint
    // sort key. Assert the call resolves rather than throws.
    const crafted = encodeListingCursor('000000900', 'apl_2', 1e300);
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ mean: 0.8 }]); // global mean re-read
    mockDbRead.$queryRaw.mockResolvedValueOnce([]); // empty id page
    await expect(
      listAvailableListings({ kind: 'all', sort: 'top-rated', cursor: crafted, limit: 20 })
    ).resolves.toEqual({ items: [], nextCursor: undefined });
    // The huge mean never reached the SQL params (it was dropped); the safe 0.8
    // fallback is what got bound into the Bayesian key.
    expect(capturedValues()).not.toContain(1e300);
    expect(capturedValues()).toContain(0.8);

    // Also large-negative, via a raw-built cursor.
    const neg = Buffer.from(`000000900${SEP}apl_2${SEP}-1e300`, 'utf8').toString('base64url');
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ mean: 0.5 }]);
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      listAvailableListings({ kind: 'all', sort: 'top-rated', cursor: neg, limit: 20 })
    ).resolves.toEqual({ items: [], nextCursor: undefined });
    expect(capturedValues()).not.toContain(-1e300);
  });

  it('sort=name bounds the sort key so a long-name nextCursor stays paginable (≤128)', async () => {
    // The name sort key is `left(LOWER(al.name), 64)` — proven in the SQL — so the
    // key encoded into the cursor is ≤64 chars and the cursor stays under the
    // `cursor: z.string().max(128)` cap even for very long names.
    await listAvailableListings({ kind: 'all', sort: 'name', limit: 20 });
    expect(capturedSql()).toMatch(/left\(LOWER\(al\.name\),\s*64\)/i);

    // A page whose last row carries the MAX (64-char) truncated key + a realistic
    // id: the emitted nextCursor must be ≤128 and round-trip, and a follow-up call
    // with it must succeed (pagination survives a >65-char name).
    const key64 = 'z'.repeat(64); // what left(lower(name),64) yields for a long name
    const longId = 'apl_' + 'c'.repeat(24); // cuid-length id
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { id: 'apl_prev', sort_key: 'a'.repeat(64) },
      { id: longId, sort_key: key64 },
      { id: 'apl_plus1', sort_key: 'z'.repeat(64) }, // the +1 (dropped → nextCursor)
    ]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      hydratedRow({ id: 'apl_prev', slug: 's-prev' }),
      hydratedRow({ id: longId, slug: 's-long' }),
    ]);
    const { nextCursor } = await listAvailableListings({ kind: 'all', sort: 'name', limit: 2 });
    expect(nextCursor).toBeDefined();
    expect((nextCursor as string).length).toBeLessThanOrEqual(128);
    // The schema cap must accept it (proves pagination doesn't halt).
    expect(listAppListingsSchema.shape.cursor.parse(nextCursor)).toBe(nextCursor);
    const decoded = decodeListingCursor(nextCursor);
    expect(decoded.cursorSortKey).toBe(key64);
    expect(decoded.cursorId).toBe(longId);

    // Follow-up page 2 with that cursor resolves (keyset accepted).
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      listAvailableListings({ kind: 'all', sort: 'name', cursor: nextCursor, limit: 2 })
    ).resolves.toEqual({ items: [], nextCursor: undefined });
  });

  it('returns an empty page (no hydration) when the keyset query is empty', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    const { items, nextCursor } = await listAvailableListings({
      kind: 'all',
      sort: 'newest',
      limit: 20,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBeUndefined();
    expect(mockDbRead.appListing.findMany).not.toHaveBeenCalled();
  });

  it('the list projection carries no internal-field leaks end-to-end', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 'apl_0', sort_key: 'k0' }]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([hydratedRow({ id: 'apl_0' })]);
    const { items } = await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    const serialized = JSON.stringify(items);
    for (const secret of ['trustTier', 'internal.example', 'super-secret', 'status']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('getListingDetail — approved-only + maturity gate', () => {
  beforeEach(() => {
    mockDbRead.appListing.findFirst.mockReset();
  });

  it('returns the projected detail for an approved listing (by slug)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...hydratedRow(), status: 'approved' });
    const detail = await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });
    expect(detail?.id).toBe('apl_1');
    // Looked up by slug.
    const where = (mockDbRead.appListing.findFirst.mock.calls.at(-1)?.[0] as { where?: unknown })
      ?.where;
    // Includes the shadow-exclusion guard (defense-in-depth).
    expect(where).toEqual({ slug: 'cool-app', revisionOfId: null });
  });

  it('looks up by id when id is provided', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...hydratedRow(), status: 'approved' });
    await getListingDetail({ id: 'apl_1' }, { scope: 'full' });
    const where = (mockDbRead.appListing.findFirst.mock.calls.at(-1)?.[0] as { where?: unknown })
      ?.where;
    expect(where).toEqual({ id: 'apl_1', revisionOfId: null });
  });

  it('the WHERE excludes SHADOW revision drafts (revisionOfId: null) for BOTH selectors', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...hydratedRow(), status: 'approved' });
    await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });
    const bySlug = (
      mockDbRead.appListing.findFirst.mock.calls.at(-1)?.[0] as {
        where?: { revisionOfId?: unknown };
      }
    )?.where;
    expect(bySlug?.revisionOfId).toBeNull();
  });

  it('returns null for a missing listing', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce(null);
    expect(await getListingDetail({ slug: 'nope' }, { scope: 'full' })).toBeNull();
  });

  it('returns null (no query) when NEITHER slug nor id is provided (enumeration guard)', async () => {
    // The zod .refine guards the tRPC boundary, but the service is exported —
    // `findFirst({ slug: undefined })` would return an arbitrary approved row.
    expect(await getListingDetail({} as never, { scope: 'full' })).toBeNull();
    expect(mockDbRead.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('returns null (no query) when BOTH slug and id are provided (ambiguous)', async () => {
    expect(
      await getListingDetail({ slug: 'cool-app', id: 'apl_1' } as never, { scope: 'full' })
    ).toBeNull();
    expect(mockDbRead.appListing.findFirst).not.toHaveBeenCalled();
  });

  it.each(['draft', 'pending', 'rejected'])('returns null for a %s listing', async (status) => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...hydratedRow(), status });
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'full' })).toBeNull();
  });

  it('hides a mature (x) listing off a non-red host', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...hydratedRow({ contentRating: 'x' }),
      status: 'approved',
    });
    expect(
      await getListingDetail({ slug: 'cool-app' }, { redCapable: false, scope: 'full' })
    ).toBeNull();
  });

  it('shows a mature (x) listing on a red-capable host', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...hydratedRow({ contentRating: 'x' }),
      status: 'approved',
    });
    const detail = await getListingDetail(
      { slug: 'cool-app' },
      { redCapable: true, scope: 'full' }
    );
    expect(detail?.contentRating).toBe('x');
  });
});

/**
 * The mod-table status filter, made EFFECTIVE-STATUS-AWARE: a draft external
 * listing that has a live pending publish request is "awaiting first review", so
 * the "Pending" filter must surface it and the "Draft" filter must exclude it.
 */
describe('moderationStatusWhere', () => {
  it('undefined (all) → no status constraint', () => {
    expect(moderationStatusWhere(undefined)).toEqual({});
  });

  it('pending → real-pending OR draft-with-a-live-pending-request', () => {
    expect(moderationStatusWhere('pending')).toEqual({
      OR: [
        { status: 'pending' },
        { status: 'draft', publishRequests: { some: { status: 'pending' } } },
      ],
    });
  });

  it('draft → only TRUE orphan drafts (no live pending request)', () => {
    expect(moderationStatusWhere('draft')).toEqual({
      status: 'draft',
      publishRequests: { none: { status: 'pending' } },
    });
  });

  it('approved → an exact status match', () => {
    expect(moderationStatusWhere('approved')).toEqual({ status: 'approved' });
  });

  it('removed → an exact status match', () => {
    expect(moderationStatusWhere('removed')).toEqual({ status: 'removed' });
  });
});

// ---------------------------------------------------------------------------
// getListingPreviewForReview — mod-only shadow-listing preview projection.
// Reuses listingHydrateSelect + projectListingCard/Detail (the SAME image→URL
// derivation as the public read); NOT status-filtered (a mod previews a draft/
// shadow). getEdgeUrl is mocked to identity, so URL fields echo the stored key.
// ---------------------------------------------------------------------------

describe('getListingPreviewForReview', () => {
  beforeEach(() => {
    mockDbRead.appListing.findUnique.mockReset();
  });

  it('projects the shadow listing into REAL card + detail (icon/cover/screenshots + scalars)', async () => {
    mockDbRead.appListing.findUnique.mockResolvedValueOnce(hydratedRow());
    const res = await getListingPreviewForReview({ listingId: 'apl_1' });
    expect(res).not.toBeNull();
    // Looked the row up by id (not a status-filtered read).
    const arg = mockDbRead.appListing.findUnique.mock.calls[0][0] as { where: { id: string } };
    expect(arg.where).toEqual({ id: 'apl_1' });
    // Card + detail carry the REAL derived image URLs (getEdgeUrl mocked to identity).
    expect(res!.card.iconUrl).toBe('icon-key');
    expect(res!.card.coverUrl).toBe('cover-key');
    expect(res!.card.name).toBe('Cool App');
    expect(res!.detail.iconUrl).toBe('icon-key');
    expect(res!.detail.coverUrl).toBe('cover-key');
    expect(res!.detail.description).toBe('# Cool app\n\nbody');
    expect(res!.detail.screenshots).toEqual([{ url: 'shot-0', caption: 'first shot' }]);
    expect(res!.detail.creator).toEqual({ id: 7, username: 'dev', image: 'avatar-key' });
  });

  it('returns null when no listing row exists for the id', async () => {
    mockDbRead.appListing.findUnique.mockResolvedValueOnce(null);
    expect(await getListingPreviewForReview({ listingId: 'missing' })).toBeNull();
  });

  it('projects partial media correctly (icon+cover, no screenshots → empty gallery, cover from cover)', async () => {
    mockDbRead.appListing.findUnique.mockResolvedValueOnce(hydratedRow({ screenshots: [] }));
    const res = await getListingPreviewForReview({ listingId: 'apl_1' });
    expect(res!.detail.screenshots).toEqual([]);
    // Cover still resolves from the cover image (not the absent first screenshot).
    expect(res!.detail.coverUrl).toBe('cover-key');
  });
});

// ---------------------------------------------------------------------------
// SOURCE REPOSITORY — the DETAIL/CARD asymmetry, and the manual-apply posture
// ---------------------------------------------------------------------------

describe('🔴 sourceRepoUrl is a DETAIL field and is NEVER on the card', () => {
  it('the detail carries the value the caller resolved', () => {
    const detail = projectListingDetail(hydratedRow() as never, [], 'https://github.com/o/r');
    expect(detail.sourceRepoUrl).toBe('https://github.com/o/r');
  });

  it('the detail defaults to null when no value is passed (the pre-migration path)', () => {
    expect(projectListingDetail(hydratedRow() as never).sourceRepoUrl).toBeNull();
    expect(projectListingDetail(hydratedRow() as never, []).sourceRepoUrl).toBeNull();
  });

  it('🔴 the CARD has no such key even when the input ROW carries the column', () => {
    // THE ACTUAL RISK: `listingHydrateSelect` is SHARED by the card and detail
    // projections, so the day the column joins that select every card row starts
    // carrying it. The card DTO is a deliberate public allowlist; a repo link on a
    // grid tile is an un-contextualised outbound link on a phishing-relevant surface.
    // Feeding the row the column is what makes this assertion non-vacuous — asserting
    // absence on a row that never had it proves nothing.
    const row = hydratedRow({ sourceRepoUrl: 'https://github.com/o/r' });
    const card = projectListingCard(row as never);
    expect(card).not.toHaveProperty('sourceRepoUrl');
    expect(JSON.stringify(card)).not.toContain('github.com');
    // …while the detail built from the SAME row still gets it, via the parameter.
    const detail = projectListingDetail(row as never, [], 'https://github.com/o/r');
    expect(detail.sourceRepoUrl).toBe('https://github.com/o/r');
  });

  it('🔴 the row column is IGNORED — the value comes from the guarded parameter only', () => {
    // The projection must never read `row.sourceRepoUrl`: that column is only present
    // if something put it in a `select`, which is exactly what the manual-apply guard
    // forbids. A projection that quietly preferred the row would make the guard
    // pointless AND would disagree with the guarded read.
    const row = hydratedRow({ sourceRepoUrl: 'https://github.com/from-the-row/x' });
    expect(projectListingDetail(row as never, [], null).sourceRepoUrl).toBeNull();
    expect(
      projectListingDetail(row as never, [], 'https://gitlab.com/from-the-param/y').sourceRepoUrl
    ).toBe('https://gitlab.com/from-the-param/y');
  });

  it('the detail DTO stays JSON-safe (the transformer-less public REST boundary)', () => {
    // `GET /api/v1/apps/{slug}` serialises this DTO with no tRPC transformer, so every
    // field must survive a plain JSON round trip. A string and a null both do; an
    // object or a Date would not.
    const detail = projectListingDetail(hydratedRow() as never, [], 'https://github.com/o/r');
    const wire = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;
    expect(wire.sourceRepoUrl).toBe('https://github.com/o/r');
    expect(typeof wire.sourceRepoUrl).toBe('string');

    const empty = JSON.parse(
      JSON.stringify(projectListingDetail(hydratedRow() as never))
    ) as Record<string, unknown>;
    // Explicitly NULL on the wire, not dropped — a client must not have to write `?? null`.
    expect('sourceRepoUrl' in empty).toBe(true);
    expect(empty.sourceRepoUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * 🔴 `openCount` — THE PLAY COUNT, AND THE NULL-vs-ZERO RULE.
 *
 * The rule this suite exists to pin, in both directions:
 *
 *   on-site  → a NUMBER. `row.metric?.openCount ?? 0`. A listing nobody has opened
 *              yet is a genuine `0`, and so is one with no metric row at all.
 *   off-site → `null`, ALWAYS, whatever the column holds.
 *
 * Why the off-site half is not cosmetic: an off-site listing's CTA is a plain
 * `target="_blank"` anchor to a third party, so no on-platform request follows the
 * click and there is nothing trustworthy to count. The number is ABSENT, not zero.
 * The renderer omits the stat row for `null`; a `0` would render as "nobody has ever
 * used this app", a false statement about an app we cannot measure.
 *
 * 🔴 EVERY OFF-SITE FIXTURE BELOW CARRIES A NON-ZERO `openCount`, and that is the
 * load-bearing property of this suite rather than a detail. `app_listing_metrics.
 * open_count` is `Int NOT NULL DEFAULT 0`, so a real off-site row DOES hold a literal
 * `0` — which means a fixture seeded with `0` cannot tell the correct projection apart
 * from the naive `row.metric?.openCount ?? 0`. Both would return the same thing and the
 * suite would be green over a broken projection. The counts are also pairwise distinct
 * and none of them is `0`, `1` or any other constant an assertion here names, so a
 * mutant that hardcodes a literal cannot survive by coincidence.
 */
describe('🔴 openCount — a NUMBER on-site, NULL off-site (never a false zero)', () => {
  /** A hydrated OFF-SITE row carrying a real, non-zero play count in the column. */
  function offsiteRow(over: Record<string, unknown> = {}) {
    return hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: 'oauth_abc',
      externalUrl: 'https://third-party.example/app',
      metric: { thumbsUpCount: 9, thumbsDownCount: 1, openCount: 8123 },
      ...over,
    });
  }

  it('the shared hydrate select actually asks for the column (otherwise nothing can be projected)', () => {
    // Positive control on the select rather than on the projection: if `openCount`
    // silently left `listingHydrateSelect`, every real card would read the
    // no-metric branch and report `0` forever while this suite's hand-built
    // fixtures kept passing.
    expect(listingHydrateSelect.metric.select.openCount).toBe(true);
    // …and the columns it already carried are still there (this is an ADD, not a swap).
    expect(listingHydrateSelect.metric.select.installCount).toBe(true);
    expect(listingHydrateSelect.metric.select.thumbsUpCount).toBe(true);
    expect(listingHydrateSelect.metric.select.thumbsDownCount).toBe(true);
  });

  it('ON-SITE with plays: the number from the metric rollup', () => {
    const card = projectListingCard(
      hydratedRow({ metric: { thumbsUpCount: 9, thumbsDownCount: 1, openCount: 4213 } }) as never
    );
    expect(card.kind).toBe('onsite');
    expect(card.openCount).toBe(4213);
  });

  it('ON-SITE with NO metric row at all: 0, not null ("no plays recorded yet" IS zero)', () => {
    const card = projectListingCard(hydratedRow({ metric: null }) as never);
    expect(card.kind).toBe('onsite');
    expect(card.openCount).toBe(0);
    expect(card.openCount).not.toBeNull();
  });

  it('ON-SITE with a metric row that omits the column: 0, not null', () => {
    // `hydratedRow()`'s default metric carries thumbs only — the `?? 0` branch.
    const card = projectListingCard(hydratedRow() as never);
    expect(card.openCount).toBe(0);
    expect(card.openCount).not.toBeNull();
  });

  it('ON-SITE whose metric row holds a literal 0: 0, not null (do NOT over-null)', () => {
    const card = projectListingCard(
      hydratedRow({ metric: { thumbsUpCount: 0, thumbsDownCount: 0, openCount: 0 } }) as never
    );
    expect(card.openCount).toBe(0);
    expect(card.openCount).not.toBeNull();
  });

  it('🔴 OFF-SITE whose metric row holds a NON-ZERO count: null — the column is ignored', () => {
    // THE case a projection ignoring `kind` cannot pass. A `0`-seeded fixture here
    // would be satisfied by `row.metric?.openCount ?? 0` and prove nothing.
    const card = projectListingCard(offsiteRow() as never);
    expect(card.kind).toBe('offsite');
    expect(card.openCount).toBeNull();
    expect(card.openCount).not.toBe(8123);
    expect(card.openCount).not.toBe(0);
  });

  it('🔴 OFF-SITE with NO metric row: null (not 0)', () => {
    const card = projectListingCard(offsiteRow({ metric: null }) as never);
    expect(card.openCount).toBeNull();
  });

  it('🔴 OFF-SITE stays null across every off-site shape, at four distinct non-zero counts', () => {
    // Sweeps the sub-shapes the store actually has: OAuth-connected, grandfathered
    // (no client id), and the `#2821` off-site row that DOES have a backing AppBlock.
    // Distinct counts so no single hardcoded literal can satisfy the loop.
    const shapes = [
      { connectClientId: 'oauth_abc', appBlockId: null, metric: { openCount: 4517 } },
      { connectClientId: null, appBlockId: null, metric: { openCount: 9902 } },
      { connectClientId: 'oauth_abc', appBlockId: 'ab_7', metric: { openCount: 3311 } },
      { connectClientId: null, appBlockId: 'ab_8', metric: { openCount: 7604 } },
    ];
    for (const shape of shapes) {
      const card = projectListingCard(offsiteRow(shape) as never);
      expect(card.openCount, JSON.stringify(shape)).toBeNull();
    }
  });

  /**
   * 🔴 THE DISCRIMINATOR IS `kind`, NOT `appBlockId` NULLNESS — and the two disagree
   * on real rows in BOTH directions, which is why this needs two assertions rather
   * than one. `schema.prisma` says so at the `appBlockId` field: a natively-created
   * OFF-SITE listing also leaves it NULL, while the `#2821` off-site rows DO carry
   * one. So an `appBlockId`-based test is wrong for an off-site row with a block
   * (a false number) and wrong for an on-site row without one (a false null).
   */
  it('🔴 ON-SITE with a NULL appBlockId is still a NUMBER (an appBlockId test would null it)', () => {
    const card = projectListingCard(
      hydratedRow({
        appBlockId: null,
        metric: { thumbsUpCount: 9, thumbsDownCount: 1, openCount: 6178 },
      }) as never
    );
    expect(card.kind).toBe('onsite');
    expect(card.openCount).toBe(6178);
  });

  it('🔴 OFF-SITE WITH a backing appBlockId is still NULL (an appBlockId test would number it)', () => {
    const card = projectListingCard(offsiteRow({ appBlockId: 'ab_9' }) as never);
    expect(card.kind).toBe('offsite');
    expect(card.openCount).toBeNull();
  });

  /**
   * 🔴 THE FAIL-CLOSED PROPERTY, GUARDED RATHER THAN ASSERTED.
   *
   * `cardOpenCount`'s doc comment claims the negative `row.kind !== 'onsite'` test
   * "fails CLOSED to `null` for any kind added later". Every OTHER fixture in this file
   * is `onsite` or `offsite`, so not one of them can tell that form apart from the
   * fail-OPEN `row.kind === 'offsite'` — under which a future kind (or a mid-migration
   * row) would project a literal `0`: the exact false "nobody has ever used this app"
   * this field exists to prevent, on a PUBLIC card. This row is the only thing in the
   * suite that can see the difference, so the claim stops being a comment.
   *
   * The metric column carries a distinct NON-ZERO count, so a pass here also cannot come
   * from the `?? 0` branch or from a hardcoded literal.
   */
  it('🔴 an UNKNOWN future kind projects null — the discriminator FAILS CLOSED, never to 0', () => {
    const card = projectListingCard(
      hydratedRow({
        kind: 'embedded',
        metric: { thumbsUpCount: 9, thumbsDownCount: 1, openCount: 1487 },
      }) as never
    );
    expect(card.openCount).toBeNull();
    expect(card.openCount).not.toBe(0);
    expect(card.openCount).not.toBe(1487);
  });

  it('🔴 two rows differing ONLY in kind land on opposite sides of the rule', () => {
    // Identical metric, identical everything else — so the difference in the output
    // can only have come from `kind`.
    const metric = { thumbsUpCount: 9, thumbsDownCount: 1, openCount: 5290 };
    const onsite = projectListingCard(hydratedRow({ metric }) as never);
    const offsite = projectListingCard(
      hydratedRow({ kind: 'offsite', appBlock: null, metric }) as never
    );
    expect(onsite.openCount).toBe(5290);
    expect(offsite.openCount).toBeNull();
  });

  it('the field is JSON-safe and EXPLICITLY null on the wire, not dropped', () => {
    // The card DTO also crosses the transformer-less public REST `GET /api/v1/apps`
    // boundary. A client must not have to write `?? null` to tell "absent" from
    // "the key was omitted".
    const offsite = JSON.parse(JSON.stringify(projectListingCard(offsiteRow() as never))) as Record<
      string,
      unknown
    >;
    expect('openCount' in offsite).toBe(true);
    expect(offsite.openCount).toBeNull();

    const onsite = JSON.parse(
      JSON.stringify(
        projectListingCard(
          hydratedRow({
            metric: { thumbsUpCount: 9, thumbsDownCount: 1, openCount: 2748 },
          }) as never
        )
      )
    ) as Record<string, unknown>;
    expect(onsite.openCount).toBe(2748);
    expect(typeof onsite.openCount).toBe('number');
  });

  /**
   * 🔴 THE TYPE MUST ADMIT `null`, or the whole rule above is unrepresentable — and
   * this is the ONLY tier that can see it from inside this file.
   *
   * 🔴 A COMPILE-TIME ASSERTION WRITTEN HERE WOULD BE INERT, and that is a measured
   * fact about this repo rather than a guess: `tsconfig.json` excludes every
   * `__tests__` directory under `src` from the root program, so THIS FILE is never
   * type-checked. A `const x: ListingCard['openCount'] = null;` written here would
   * compile-error nowhere and pass at runtime whatever the type said. Hence the source
   * parse — the same read-the-authority-out-of-the-schema move
   * `appListingGrid.test.ts` uses for the page-size cap, with the same positive
   * control on the parse itself.
   *
   * The typecheck tier IS covered, just not from here: narrowing the field to `number`
   * reds `pnpm typecheck` at the PRODUCTION call sites, which are in scope — measured
   * at 5 errors, including `app-listing.service.ts` (this projection returns
   * `number | null`) and `reviewListingPreview.ts` (which passes a literal `null`).
   */
  it('🔴 the DTO declares `openCount: number | null` (source tier — visible to a plain vitest run)', () => {
    const schemaSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../schema/blocks/app-listing-read.schema.ts'),
      'utf8'
    );
    // Positive control on the parse: the card type must be findable at all, and it
    // must contain a field we know is there. A regex that matched nothing would
    // otherwise report "no violation" for a file it never read.
    const cardDecl = schemaSrc.match(/export type ListingCard = \{([\s\S]*?)\n\};/);
    expect(cardDecl, 'could not locate `export type ListingCard`').not.toBeNull();
    const body = cardDecl![1];
    expect(body, 'positive control: reviewCount should be in the parsed body').toMatch(
      /^\s*reviewCount: number;$/m
    );
    // …and now the claim itself.
    expect(body).toMatch(/^\s*openCount: number \| null;$/m);
    expect(body).not.toMatch(/^\s*openCount: number;$/m);
  });
});

describe('the beta projections — flag, note, and the stale-note rule', () => {
  const BETA = { available: true, isBeta: true, betaMessage: 'rough edges' };
  const OFF = { available: true, isBeta: false, betaMessage: null };
  const UNAVAILABLE = { available: false, isBeta: false, betaMessage: null };

  it('projects the flag onto the CARD and the flag + note onto the DETAIL', () => {
    expect(projectListingCard(hydratedRow() as never, BETA).isBeta).toBe(true);
    const detail = projectListingDetail(hydratedRow() as never, [], null, BETA);
    expect(detail.isBeta).toBe(true);
    expect(detail.betaMessage).toBe('rough edges');
  });

  it('defaults to NOT beta when no beta read is passed (every pre-existing call site)', () => {
    expect(projectListingCard(hydratedRow() as never).isBeta).toBe(false);
    expect(projectListingDetail(hydratedRow() as never).isBeta).toBe(false);
    expect(projectListingDetail(hydratedRow() as never).betaMessage).toBeNull();
  });

  it('an UNAVAILABLE read projects exactly like "not in beta"', () => {
    // The manual-apply window renders identically to the ordinary case — the difference
    // lives in `available`, which only the WRITE paths consult.
    expect(projectListingCard(hydratedRow() as never, UNAVAILABLE).isBeta).toBe(false);
    expect(
      projectListingDetail(hydratedRow() as never, [], null, UNAVAILABLE).betaMessage
    ).toBeNull();
  });

  it('🔴 does NOT project a stale note when the flag is OFF', () => {
    // A row can hold a note from an author who later unticked the box — the server clears
    // it only on the next write, and rows written before that rule existed can carry one.
    // Nulling it at the PROJECTION is what makes that unreachable for every row, not just
    // for rows written from now on.
    const stale = { available: true, isBeta: false, betaMessage: 'left over from before' };
    expect(projectListingDetail(hydratedRow() as never, [], null, stale).betaMessage).toBeNull();
  });

  it('positive control — the same projection DOES carry a note when the flag is on', () => {
    // Without this, the assertion above would pass on a projection that nulls the note
    // unconditionally.
    expect(projectListingDetail(hydratedRow() as never, [], null, BETA).betaMessage).toBe(
      'rough edges'
    );
  });

  it('a beta listing with no note keeps the FLAG (the note is not the label)', () => {
    const noNote = { available: true, isBeta: true, betaMessage: null };
    expect(projectListingDetail(hydratedRow() as never, [], null, noNote).isBeta).toBe(true);
    expect(projectListingCard(hydratedRow() as never, noNote).isBeta).toBe(true);
  });

  it('the OFF read and the card default agree', () => {
    expect(projectListingCard(hydratedRow() as never, OFF).isBeta).toBe(
      projectListingCard(hydratedRow() as never).isBeta
    );
  });
});

describe('🔴 getListingPreviewForReview reads beta from the PARENT for a shadow', () => {
  /**
   * 🔴 THIS IS THE MECHANISM THAT REPLACED THE CLONE, so it is the thing that must not
   * regress. `beginListingRevision` used to copy the beta columns onto the shadow purely so
   * this preview could render them. That forced the parent's beta write to land BEFORE the
   * shadow was minted, which hoisted a WRITE above the patch validation and made a rejected
   * patch apply its beta half anyway. Reading the parent here needs no clone and no ordering
   * rule. Keying it on the SHADOW instead would not merely go stale — nothing writes a
   * shadow's beta columns, so it would read the schema defaults and strip the badge from
   * every preview.
   *
   * The beta reader is NOT mocked in this suite, so these assertions exercise the real
   * `readListingBetaForRender` and read the query it actually issues.
   */
  /** The `findUnique` call the guarded beta reader makes, or undefined. */
  function betaLookup() {
    return (
      mockDbRead.appListing.findUnique.mock.calls
        .map((c) => c[0] as { where?: { id?: string }; select?: Record<string, unknown> })
        .find((a) => a?.select && 'isBeta' in a.select) ?? undefined
    );
  }
  /** The `findUnique` call the guarded SOURCE-REPO reader makes, or undefined. */
  function sourceRepoLookup() {
    return (
      mockDbRead.appListing.findUnique.mock.calls
        .map((c) => c[0] as { where?: { id?: string }; select?: Record<string, unknown> })
        .find((a) => a?.select && 'sourceRepoUrl' in a.select) ?? undefined
    );
  }

  beforeEach(() => {
    mockDbRead.appListing.findUnique.mockReset();
  });

  it('keys the beta read on `revisionOfId`, not on the shadow id', async () => {
    mockDbRead.appListing.findUnique.mockResolvedValue({
      ...hydratedRow(),
      id: 'apl_shadow',
      revisionOfId: 'apl_parent',
    });
    await getListingPreviewForReview({ listingId: 'apl_shadow' });
    expect(betaLookup()?.where).toEqual({ id: 'apl_parent' });
  });

  it('keys it on the row itself for a NON-shadow listing (positive control)', async () => {
    // Without this, the assertion above would also pass on an implementation that read some
    // other id unconditionally — this pins that the parent hop is conditional on being a
    // shadow, i.e. on `revisionOfId` being non-null.
    mockDbRead.appListing.findUnique.mockResolvedValue({
      ...hydratedRow(),
      id: 'apl_parent',
      revisionOfId: null,
    });
    await getListingPreviewForReview({ listingId: 'apl_parent' });
    expect(betaLookup()?.where).toEqual({ id: 'apl_parent' });
  });

  it('🔴 the SOURCE-REPO read still keys on the SHADOW — the two are opposite questions', async () => {
    // `sourceRepoUrl` IS staged on a revision (a MATERIAL field the apply copies), so the
    // moderator must see the SHADOW's value — the one approving will publish. Beta is never
    // staged, so they must see the PARENT's. Same function, opposite keys; this pins that a
    // future "consolidation" cannot collapse them into one id.
    mockDbRead.appListing.findUnique.mockResolvedValue({
      ...hydratedRow(),
      id: 'apl_shadow',
      revisionOfId: 'apl_parent',
    });
    await getListingPreviewForReview({ listingId: 'apl_shadow' });
    expect(sourceRepoLookup()?.where).toEqual({ id: 'apl_shadow' });
    expect(betaLookup()?.where).toEqual({ id: 'apl_parent' });
  });

  it('surfaces the parent beta declaration into BOTH projections', async () => {
    mockDbRead.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args?.select && 'isBeta' in args.select)
          return { isBeta: true, betaMessage: 'reviewer sees this' };
        if (args?.select && 'sourceRepoUrl' in args.select) return { sourceRepoUrl: null };
        return { ...hydratedRow(), id: 'apl_shadow', revisionOfId: 'apl_parent' };
      }
    );
    const res = await getListingPreviewForReview({ listingId: 'apl_shadow' });
    expect(res!.card.isBeta).toBe(true);
    expect(res!.detail.isBeta).toBe(true);
    expect(res!.detail.betaMessage).toBe('reviewer sees this');
  });
});
