import { describe, expect, it, vi } from 'vitest';

import {
  mergeReviewRows,
  offsiteRequestToUnifiedRow,
  onsiteRequestToUnifiedRow,
  type OffsiteReviewRequest,
  type OnsiteReviewRequest,
  type UnifiedReviewRow,
} from '~/components/Apps/unifiedReviewRow';

/**
 * The CORRECTNESS CORE of the unified /apps/review queues: the pure adapters that
 * map each proc's row → a unified row + the merge/sort/dedup. A mis-routed, dropped,
 * or duplicated row here means a moderator reviews/approves the wrong thing, so this
 * is the BLOCKING unit gate (the list's browser suite is report-only). Pins:
 *  - globally-unique, kind-namespaced keys (on-site + off-site never collide);
 *  - correct field mapping + the manifest-name / listing-name → slug fallbacks;
 *  - `onReview` routes to the CORRECT modal opener with the CORRECT payload;
 *  - the pending timestamp is `submittedAt`, the decided timestamp is `reviewedAt`;
 *  - merge = no-drop + dedup-by-key + asc/desc sort + a stable, direction-
 *    independent tiebreak.
 */

// ---------------------------------------------------------------------------
// Fixtures — minimal structural rows (cast to the adapter input types; the
// adapters only read a handful of fields).
// ---------------------------------------------------------------------------

function onsite(over: Partial<OnsiteReviewRequest> & { id: string }): OnsiteReviewRequest {
  return {
    id: over.id,
    appBlockId: null,
    slug: 'onsite-slug',
    version: '1.0.0',
    submittedAt: '2026-01-01T00:00:00Z',
    bundleSizeBytes: '10',
    bundleSha256: 'sha',
    manifest: {},
    fileSummary: {},
    manifestDiffSummary: {},
    reviewRepoUrl: 'https://forgejo.example/repo',
    submittedBy: { id: 7, username: 'onsite-dev', image: null },
    ...over,
  } as OnsiteReviewRequest;
}

function offsite(over: Partial<OffsiteReviewRequest> & { id: string }): OffsiteReviewRequest {
  return {
    id: over.id,
    appListingId: 'apl_1',
    slug: 'offsite-slug',
    status: 'pending',
    submittedAt: '2026-01-02T00:00:00Z',
    changelog: null,
    appListing: {
      name: 'External App',
      externalUrl: 'https://ex.com',
      category: 'utility',
      contentRating: 'g',
    },
    submittedBy: { id: 9, username: 'offsite-dev', image: null },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// onsiteRequestToUnifiedRow
// ---------------------------------------------------------------------------

describe('onsiteRequestToUnifiedRow', () => {
  it('maps fields, namespaces the key, and prefers the manifest name for the title', () => {
    const req = onsite({ id: 'r1', slug: 'my-block', manifest: { name: 'My Block' } });
    const row = onsiteRequestToUnifiedRow(req, vi.fn());
    expect(row.key).toBe('onsite:r1');
    expect(row.kind).toBe('onsite');
    expect(row.badge).toBe('App');
    expect(row.badgeColor).toBe('blue');
    expect(row.title).toBe('My Block');
    expect(row.slug).toBe('my-block');
    expect(row.submitter).toEqual({ id: 7, username: 'onsite-dev', image: null });
  });

  it('falls back to the slug when the manifest has no usable name', () => {
    expect(onsiteRequestToUnifiedRow(onsite({ id: 'r1', slug: 's', manifest: {} }), vi.fn()).title).toBe('s');
    expect(
      onsiteRequestToUnifiedRow(onsite({ id: 'r2', slug: 's2', manifest: { name: '' } }), vi.fn()).title
    ).toBe('s2');
    expect(
      onsiteRequestToUnifiedRow(onsite({ id: 'r3', slug: 's3', manifest: null as unknown as object }), vi.fn())
        .title
    ).toBe('s3');
  });

  it('uses submittedAt for a pending row and reviewedAt for a decided row', () => {
    const pending = onsiteRequestToUnifiedRow(
      onsite({ id: 'p', submittedAt: '2026-03-01T00:00:00Z' }),
      vi.fn()
    );
    expect(pending.submittedAt.toISOString()).toBe('2026-03-01T00:00:00.000Z');

    const approved = onsiteRequestToUnifiedRow(
      onsite({
        id: 'a',
        submittedAt: '2026-03-01T00:00:00Z',
        reviewedAt: '2026-03-05T00:00:00Z',
      } as Partial<OnsiteReviewRequest> & { id: string }),
      vi.fn()
    );
    expect(approved.submittedAt.toISOString()).toBe('2026-03-05T00:00:00.000Z');
  });

  it('wires onReview to the on-site opener with the ORIGINAL request', () => {
    const open = vi.fn();
    const req = onsite({ id: 'r1' });
    const row = onsiteRequestToUnifiedRow(req, open);
    row.onReview();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(req);
  });
});

// ---------------------------------------------------------------------------
// offsiteRequestToUnifiedRow
// ---------------------------------------------------------------------------

describe('offsiteRequestToUnifiedRow', () => {
  it('maps fields, namespaces the key, and prefers the listing name for the title', () => {
    const req = offsite({ id: 'o1', slug: 'ext-app' });
    const row = offsiteRequestToUnifiedRow(req, vi.fn());
    expect(row.key).toBe('offsite:o1');
    expect(row.kind).toBe('offsite');
    expect(row.badge).toBe('External');
    expect(row.badgeColor).toBe('grape');
    expect(row.title).toBe('External App');
    expect(row.slug).toBe('ext-app');
    expect(row.submitter).toEqual({ id: 9, username: 'offsite-dev', image: null });
  });

  it('falls back to the slug when the listing (or its name) is absent', () => {
    expect(offsiteRequestToUnifiedRow(offsite({ id: 'o1', slug: 'sx', appListing: null }), vi.fn()).title).toBe(
      'sx'
    );
    expect(
      offsiteRequestToUnifiedRow(
        offsite({
          id: 'o2',
          slug: 'sy',
          appListing: { name: null, externalUrl: null, category: null, contentRating: null },
        }),
        vi.fn()
      ).title
    ).toBe('sy');
  });

  it('uses submittedAt for a pending row and reviewedAt for a decided row', () => {
    const pending = offsiteRequestToUnifiedRow(
      offsite({ id: 'p', submittedAt: '2026-04-01T00:00:00Z' }),
      vi.fn()
    );
    expect(pending.submittedAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');

    const approved = offsiteRequestToUnifiedRow(
      offsite({ id: 'a', submittedAt: '2026-04-01T00:00:00Z', reviewedAt: '2026-04-09T00:00:00Z' }),
      vi.fn()
    );
    expect(approved.submittedAt.toISOString()).toBe('2026-04-09T00:00:00.000Z');
  });

  it('wires onReview to the off-site opener with an OffsitePendingRow (pending request id + listing id + connect fields)', () => {
    const open = vi.fn();
    const req = offsite({
      id: 'alpr_9',
      appListingId: 'apl_9',
      slug: 'connect-app',
      changelog: 'note',
      appListing: {
        name: 'Connect App',
        externalUrl: null,
        category: 'utility',
        contentRating: 'g',
        connectClientId: 'cc_1',
        connectRequestedScopes: 3,
        connectScopeJustifications: { READ: 'why' },
        connectClient: { name: 'Client' },
      },
    });
    const row = offsiteRequestToUnifiedRow(req, open);
    row.onReview();
    expect(open).toHaveBeenCalledTimes(1);
    const passed = open.mock.calls[0][0];
    // The modal is approve/reject-driven by the PUBLISH REQUEST id (not the listing id).
    expect(passed.id).toBe('alpr_9');
    expect(passed.appListingId).toBe('apl_9');
    expect(passed.slug).toBe('connect-app');
    expect(passed.changelog).toBe('note');
    expect(passed.appListing).toMatchObject({
      name: 'Connect App',
      connectClientId: 'cc_1',
      connectRequestedScopes: 3,
      connectScopeJustifications: { READ: 'why' },
      connectClient: { name: 'Client' },
    });
    expect(passed.submittedBy).toEqual({ id: 9, username: 'offsite-dev', image: null });
  });

  it('defaults absent connect fields to null (external-link listing)', () => {
    const open = vi.fn();
    offsiteRequestToUnifiedRow(offsite({ id: 'o1' }), open).onReview();
    const passed = open.mock.calls[0][0];
    expect(passed.appListing.connectClientId).toBeNull();
    expect(passed.appListing.connectRequestedScopes).toBeNull();
    expect(passed.appListing.connectScopeJustifications).toBeNull();
    expect(passed.appListing.connectClient).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// On-site listing-MEDIA revision (`kind: 'onsite'`) — reviewed by the SAME listing
// adapter/modal as an external listing, but with a distinct badge + key namespace.
// This is the review-surface half of onsite listing-media revisions: the queue proc
// (widened separately) tags such a row `kind: 'onsite'`; the adapter must badge it
// "Listing media", route it to the LISTING opener (NOT the code modal), and namespace
// its key so it can never collide/dedup with an external listing or a code request.
// ---------------------------------------------------------------------------

describe('offsiteRequestToUnifiedRow — on-site listing-media revision (kind: onsite)', () => {
  it('badges it "Listing media", namespaces the key, and keeps the LISTING routing kind', () => {
    const req = offsite({ id: 'lm1', slug: 'onsite-app', kind: 'onsite' });
    const row = offsiteRequestToUnifiedRow(req, vi.fn());
    expect(row.key).toBe('onsite-listing:lm1');
    // Routing kind stays `offsite` (opens the listing modal, NOT the code modal).
    expect(row.kind).toBe('offsite');
    expect(row.badge).toBe('Listing media');
    expect(row.badgeColor).toBe('teal');
    expect(row.title).toBe('External App');
  });

  it('opens the LISTING (off-site) opener with an OffsitePendingRow carrying kind=onsite', () => {
    const open = vi.fn();
    const req = offsite({
      id: 'lm2',
      appListingId: 'apl_onsite',
      slug: 'onsite-app',
      kind: 'onsite',
    });
    offsiteRequestToUnifiedRow(req, open).onReview();
    expect(open).toHaveBeenCalledTimes(1);
    const passed = open.mock.calls[0][0];
    expect(passed.id).toBe('lm2');
    expect(passed.appListingId).toBe('apl_onsite');
    // The row the modal receives must carry the onsite kind so it renders the
    // "listing media" header + cap-at-app-rating review.
    expect(passed.kind).toBe('onsite');
  });

  it('an absent kind (older payload) still behaves as an external listing', () => {
    const row = offsiteRequestToUnifiedRow(offsite({ id: 'o9', slug: 's' }), vi.fn());
    expect(row.key).toBe('offsite:o9');
    expect(row.badge).toBe('External');
  });
});

// ---------------------------------------------------------------------------
// Cross-kind key uniqueness
// ---------------------------------------------------------------------------

describe('key namespacing', () => {
  it('an on-site and an off-site request sharing a raw id get DISTINCT keys', () => {
    const onsiteRow = onsiteRequestToUnifiedRow(onsite({ id: 'shared' }), vi.fn());
    const offsiteRow = offsiteRequestToUnifiedRow(offsite({ id: 'shared' }), vi.fn());
    expect(onsiteRow.key).toBe('onsite:shared');
    expect(offsiteRow.key).toBe('offsite:shared');
    expect(onsiteRow.key).not.toBe(offsiteRow.key);
  });

  it('a code request, an external listing, and an on-site listing-media row sharing a raw id get 3 DISTINCT keys', () => {
    const code = onsiteRequestToUnifiedRow(onsite({ id: 'dup' }), vi.fn());
    const external = offsiteRequestToUnifiedRow(offsite({ id: 'dup' }), vi.fn());
    const listingMedia = offsiteRequestToUnifiedRow(offsite({ id: 'dup', kind: 'onsite' }), vi.fn());
    const keys = [code.key, external.key, listingMedia.key];
    expect(keys).toEqual(['onsite:dup', 'offsite:dup', 'onsite-listing:dup']);
    expect(new Set(keys).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// mergeReviewRows
// ---------------------------------------------------------------------------

function row(key: string, iso: string): UnifiedReviewRow {
  const isOnsiteCode = key.startsWith('onsite:');
  return {
    key,
    // `onsite:` = code review; everything else routes to the listing modal.
    kind: isOnsiteCode ? 'onsite' : 'offsite',
    badge: isOnsiteCode ? 'App' : key.startsWith('onsite-listing:') ? 'Listing media' : 'External',
    badgeColor: isOnsiteCode ? 'blue' : key.startsWith('onsite-listing:') ? 'teal' : 'grape',
    title: key,
    submitter: null,
    submittedAt: new Date(iso),
    onReview: () => undefined,
  };
}

describe('mergeReviewRows', () => {
  it('empty in → empty out', () => {
    expect(mergeReviewRows([], [], 'asc')).toEqual([]);
    expect(mergeReviewRows([], [], 'desc')).toEqual([]);
  });

  it('one-sided (only on-site, or only off-site) passes through, sorted', () => {
    const a = row('onsite:a', '2026-01-03T00:00:00Z');
    const b = row('onsite:b', '2026-01-01T00:00:00Z');
    expect(mergeReviewRows([a, b], [], 'asc').map((r) => r.key)).toEqual(['onsite:b', 'onsite:a']);
    expect(mergeReviewRows([], [a, b], 'desc').map((r) => r.key)).toEqual(['onsite:a', 'onsite:b']);
  });

  it('interleaves the two sources by date — ascending (oldest-first, pending)', () => {
    const on = [row('onsite:1', '2026-01-01T00:00:00Z'), row('onsite:3', '2026-01-05T00:00:00Z')];
    const off = [row('offsite:2', '2026-01-03T00:00:00Z')];
    expect(mergeReviewRows(on, off, 'asc').map((r) => r.key)).toEqual([
      'onsite:1',
      'offsite:2',
      'onsite:3',
    ]);
  });

  it('interleaves the two sources by date — descending (newest-first, history)', () => {
    const on = [row('onsite:1', '2026-01-01T00:00:00Z'), row('onsite:3', '2026-01-05T00:00:00Z')];
    const off = [row('offsite:2', '2026-01-03T00:00:00Z')];
    expect(mergeReviewRows(on, off, 'desc').map((r) => r.key)).toEqual([
      'onsite:3',
      'offsite:2',
      'onsite:1',
    ]);
  });

  it('dedups by key — a repeated key appears once (first occurrence wins)', () => {
    const first = { ...row('onsite:x', '2026-01-01T00:00:00Z'), title: 'first' };
    const dup = { ...row('onsite:x', '2026-01-09T00:00:00Z'), title: 'second' };
    const merged = mergeReviewRows([first, dup], [], 'asc');
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('first');
  });

  it('never drops a row: N on-site + M off-site (distinct keys) → N+M rows', () => {
    const on = Array.from({ length: 4 }, (_, i) => row(`onsite:${i}`, `2026-01-0${i + 1}T00:00:00Z`));
    const off = Array.from({ length: 3 }, (_, i) => row(`offsite:${i}`, `2026-02-0${i + 1}T00:00:00Z`));
    expect(mergeReviewRows(on, off, 'asc')).toHaveLength(7);
  });

  it('equal timestamps get a STABLE, direction-independent tiebreak by key', () => {
    const ts = '2026-01-01T00:00:00Z';
    const rows = [row('onsite:b', ts), row('offsite:a', ts), row('onsite:c', ts)];
    // asc + desc must both tiebreak by key ascending (deterministic order).
    expect(mergeReviewRows(rows, [], 'asc').map((r) => r.key)).toEqual([
      'offsite:a',
      'onsite:b',
      'onsite:c',
    ]);
    expect(mergeReviewRows(rows, [], 'desc').map((r) => r.key)).toEqual([
      'offsite:a',
      'onsite:b',
      'onsite:c',
    ]);
  });

  it('interleaves all three row kinds (code + external + on-site listing-media) by date with no drop/dedup collision', () => {
    // Code rows arrive via the on-site arg; BOTH listing sub-kinds (external +
    // on-site listing-media) arrive via the off-site arg (the appListings query).
    const code = [row('onsite:c', '2026-01-01T00:00:00Z')];
    const listing = [
      row('offsite:e', '2026-01-02T00:00:00Z'),
      row('onsite-listing:m', '2026-01-03T00:00:00Z'),
    ];
    const merged = mergeReviewRows(code, listing, 'asc');
    expect(merged.map((r) => r.key)).toEqual(['onsite:c', 'offsite:e', 'onsite-listing:m']);
    // The on-site listing-media row carries its own badge through the merge.
    expect(merged.find((r) => r.key === 'onsite-listing:m')?.badge).toBe('Listing media');
  });

  it('does not mutate the input arrays', () => {
    const on = [row('onsite:2', '2026-01-02T00:00:00Z'), row('onsite:1', '2026-01-01T00:00:00Z')];
    const snapshot = on.map((r) => r.key);
    mergeReviewRows(on, [], 'asc');
    expect(on.map((r) => r.key)).toEqual(snapshot);
  });
});
