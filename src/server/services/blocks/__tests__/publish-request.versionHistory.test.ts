import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MOD-ONLY prior-versions read (`blocks.listVersionHistory`) and the store-listing
 * projection the three mod-queue list procs now carry.
 *
 * Both are slug-keyed, and that is the whole point: `AppBlockPublishRequest.appBlockId` is
 * NULL while an app's FIRST request is pending, so an id-keyed read or join returns nothing
 * for exactly the rows a moderator reviews most carefully.
 *
 * `dbRead` comes from the canonical shared db mock (`~/__tests__/mocks/db.mock`, which
 * `no-direct-shared-module-mock` requires) and `forgejo.service` is stubbed here, so no
 * generated Prisma client or Forgejo config is touched.
 */

const { mockReviewRepoUrl, mockRepoCommitUrl } = vi.hoisted(() => ({
  mockReviewRepoUrl: vi.fn((slug: string) => `https://forgejo.example/review/${slug}`),
  mockRepoCommitUrl: vi.fn(
    (slug: string, ref: string) => `https://forgejo.example/${slug}/commit/${ref}`
  ),
}));

vi.mock('~/server/services/blocks/forgejo.service', () => ({
  reviewRepoUrl: mockReviewRepoUrl,
  repoCommitUrl: mockRepoCommitUrl,
}));

import {
  listApprovedRequests,
  listPendingRequests,
  listRejectedRequests,
  listVersionHistory,
  VERSION_HISTORY_LIMIT,
} from '~/server/services/blocks/publish-request.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;

/** A history row shaped as `listVersionHistory`'s `select` returns it. */
function historyRow(over: Partial<Record<string, unknown>> & { id: string }) {
  return {
    version: '1.0.0',
    status: 'approved',
    submittedAt: new Date('2026-03-01T00:00:00Z'),
    reviewedAt: new Date('2026-03-02T00:00:00Z'),
    rejectionReason: null,
    deployState: 'live',
    submittedBy: { id: 7, username: 'author', deletedAt: null, image: null },
    reviewedBy: { id: 9, username: 'mod', deletedAt: null, image: null },
    ...over,
  };
}

/** A queue row shaped as `listPendingRequests`'s `select` returns it. */
function queueRow(over: Partial<Record<string, unknown>> & { id: string; slug: string }) {
  return {
    appBlockId: null,
    version: '1.0.0',
    submittedAt: new Date('2026-03-01T00:00:00Z'),
    bundleSizeBytes: BigInt(2048),
    bundleSha256: 'sha-abc',
    manifest: {},
    fileSummary: {},
    manifestDiffSummary: {},
    forgejoCommitSha: null,
    submittedBy: { id: 7, username: 'author', deletedAt: null, image: null },
    ...over,
  };
}

/**
 * An `AppListing` row shaped as the queue join's `select` returns it, defaulting to the
 * PRE-APPROVAL DRAFT shape (`appBlockId: null`, owned by the default `queueRow` submitter)
 * so the common case needs no overrides.
 */
function listingRow(over: Partial<Record<string, unknown>> & { slug: string }) {
  return {
    kind: 'onsite',
    appBlockId: null,
    userId: 7,
    icon: { url: 'icon-uuid' },
    cover: { url: 'cover-uuid' },
    metric: { openCount: 4821 },
    ...over,
  };
}

beforeEach(() => {
  mockDbRead.appBlockPublishRequest.findMany.mockReset();
  mockDbRead.appListing.findMany.mockReset();
  mockDbRead.appListing.findMany.mockResolvedValue([]);
});

describe('listVersionHistory — keyed on SLUG, newest-first, bounded', () => {
  it('queries by SLUG ALONE, so a pending first version with a NULL appBlockId is found', async () => {
    // 🔴 THE REGRESSION THIS EXISTS FOR. An `appBlockId`-keyed read would return nothing
    // here, and nothing would error — the modal would simply say "no submissions" about an
    // app with a live pending request.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      historyRow({ id: 'pubreq_1', status: 'pending', reviewedAt: null }),
    ]);
    const result = await listVersionHistory({ slug: 'first-timer' });
    const args = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ slug: 'first-timer' });
    expect(JSON.stringify(args.where)).not.toContain('appBlockId');
    expect(result.items.map((r: { id: string }) => r.id)).toEqual(['pubreq_1']);
  });

  it('orders newest-first by submittedAt', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    await listVersionHistory({ slug: 'any-app' });
    expect(mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0].orderBy).toEqual({
      submittedAt: 'desc',
    });
  });

  it('includes EVERY status, so the modal reads as a full history rather than a gap', async () => {
    // No `status` filter at all — the current (pending) request has to be in the list or a
    // moderator reading it cannot tell what they are looking at.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      historyRow({ id: 'p', status: 'pending', reviewedAt: null }),
      historyRow({ id: 'r', status: 'rejected', rejectionReason: 'no' }),
      historyRow({ id: 'w', status: 'withdrawn' }),
      historyRow({ id: 'a', status: 'approved' }),
    ]);
    const result = await listVersionHistory({ slug: 'any-app' });
    expect(Object.keys(mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0].where)).toEqual([
      'slug',
    ]);
    expect(result.items.map((r: { status: string }) => r.status)).toEqual([
      'pending',
      'rejected',
      'withdrawn',
      'approved',
    ]);
  });

  it('takes LIMIT + 1 and reports truncation without leaking the extra row', async () => {
    const rows = Array.from({ length: VERSION_HISTORY_LIMIT + 1 }, (_, i) =>
      historyRow({ id: `pubreq_${i}` })
    );
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue(rows);
    const result = await listVersionHistory({ slug: 'busy-app' });
    expect(mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0].take).toBe(
      VERSION_HISTORY_LIMIT + 1
    );
    expect(result.items).toHaveLength(VERSION_HISTORY_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.items.at(-1)?.id).toBe(`pubreq_${VERSION_HISTORY_LIMIT - 1}`);
  });

  it('a page at exactly the limit is NOT truncated (the off-by-one)', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue(
      Array.from({ length: VERSION_HISTORY_LIMIT }, (_, i) => historyRow({ id: `pubreq_${i}` }))
    );
    const result = await listVersionHistory({ slug: 'busy-app' });
    expect(result.items).toHaveLength(VERSION_HISTORY_LIMIT);
    expect(result.truncated).toBe(false);
  });

  it('🔴 does NOT project deployDetail — it carries a tenant-influenced build-log excerpt', async () => {
    const select = (() => {
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
      return listVersionHistory({ slug: 'any-app' }).then(
        () => mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0].select
      );
    })();
    const resolved = await select;
    expect(resolved.deployDetail).toBeUndefined();
    // Positive control: the sibling field it is easily confused with IS projected, so the
    // assertion above is about `deployDetail` rather than about an empty select.
    expect(resolved.deployState).toBe(true);
    // …and so are the fields the modal renders, including both user chips.
    for (const field of ['id', 'version', 'status', 'submittedAt', 'reviewedAt', 'rejectionReason'])
      expect(resolved[field], `${field} must be projected`).toBe(true);
    // 🔴 `deletedAt` IS PART OF BOTH CHIPS. `PriorVersionsModal` renders each of these
    // through `UserAvatar`, which BRANCHES on `deletedAt` twice — `UserProfileLink`
    // suppresses `linkToProfile` for a deleted account and `Username` renders "[deleted]".
    // Without the field the value is `undefined` ⇒ falsy ⇒ a deleted user renders as a live,
    // linked account. Asserted as an exact shape (not `toContain`) because the five
    // `submittedBy` readers in this service must stay identical to each other; that parity
    // rule lives in `src/server/services/blocks/__tests__/review-submitter-select-parity.test.ts`.
    const CHIP = { select: { id: true, username: true, deletedAt: true, image: true } };
    expect(resolved.submittedBy).toEqual(CHIP);
    expect(resolved.reviewedBy).toEqual(CHIP);
    // No bundle pointers, no manifest blob: the modal is a list of dates and verdicts.
    expect(resolved.manifest).toBeUndefined();
    expect(resolved.bundleKey).toBeUndefined();
  });
});

describe('the mod queue rows carry the app store listing, joined on SLUG', () => {
  it('projects playCount + iconUrl + coverUrl from the listing matching the row slug', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_a', slug: 'has-listing' }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([listingRow({ slug: 'has-listing' })]);
    const result = await listPendingRequests({ limit: 10 });
    const where = mockDbRead.appListing.findMany.mock.calls[0][0].where;
    expect(where.slug).toEqual({ in: ['has-listing'] });
    const row = result.items[0];
    expect(row.playCount).toBe(4821);
    // The URLs are CDN-transformed rather than raw `Image.url`, and no raw Image row
    // reaches the client.
    expect(row.iconUrl).toContain('icon-uuid');
    expect(row.coverUrl).toContain('cover-uuid');
    expect(row).not.toHaveProperty('icon');
    expect(row).not.toHaveProperty('cover');
    expect(row).not.toHaveProperty('metric');
  });

  describe('🔴 a slug-matched listing is only used when it BELONGS to the request', () => {
    /**
     * 🔴 THE BUG THIS CLOSES, REACHABLE BY AUTHOR ACTIONS ALONE. A slug is RELEASED when a
     * first version is withdrawn or its orphan draft purged, while the decided request row
     * survives in the Rejected tab forever — so a second developer can claim it. A
     * slug-only join then prints THEIR icon, cover and lifetime play count on the first
     * developer's row, under the first developer's name, with the icon a live button into
     * the image viewer.
     *
     * Every case below uses the SAME slug on both sides, so slug equality can never be
     * what makes one pass and another fail.
     */
    const SLUG = 'contested';

    it('an OFF-SITE listing on the slug is ignored — ONLY the kind differs here', async () => {
      // 🔴 THE FIXTURE OVERRIDES `kind` AND NOTHING ELSE, and that is the assertion. An
      // earlier revision also set `userId: 999`, so the owner conjunct rejected the row and
      // the kind test never executed — deleting the kind test left this arm GREEN. The
      // listing keeps `queueRow`'s own submitter, so kind is the only thing that can
      // decide it.
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_a', slug: SLUG, appBlockId: null, submittedBy: { id: 7 } }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: SLUG, kind: 'offsite' }),
      ]);
      const result = await listRejectedRequests({ limit: 10 });
      expect(result.items[0]).toMatchObject({ playCount: null, iconUrl: null, coverUrl: null });
    });

    it("another developer's APPROVED on-site app on the same slug is ignored", async () => {
      // `kind: 'onsite'` alone is not enough — B's app being approved mints an on-site
      // listing with ITS OWN appBlockId, which A's never-approved row must not adopt.
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_a', slug: SLUG, appBlockId: null }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: SLUG, appBlockId: 'apb_other', userId: 999 }),
      ]);
      const result = await listRejectedRequests({ limit: 10 });
      expect(result.items[0].playCount).toBeNull();
    });

    it("another developer's DRAFT on the same slug is ignored (owner mismatch)", async () => {
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_a', slug: SLUG, appBlockId: null, submittedBy: { id: 7 } }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: SLUG, appBlockId: null, userId: 999 }),
      ]);
      const result = await listRejectedRequests({ limit: 10 });
      expect(result.items[0].playCount).toBeNull();
    });

    it("a DIFFERENT app block's listing is ignored when BOTH sides are keyed", async () => {
      // Two ids that disagree is the one shape that loses outright — the owner fallback
      // does not get a say, which is what stops a keyed listing being adopted by a keyed
      // request for another app.
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_a', slug: SLUG, appBlockId: 'apb_mine', submittedBy: { id: 7 } }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: SLUG, appBlockId: 'apb_theirs', userId: 7 }),
      ]);
      const result = await listApprovedRequests({ limit: 10 });
      expect(result.items[0].playCount).toBeNull();
    });

    it("🔴 a REJECTED row still shows its app's listing after a later version was approved", async () => {
      /**
       * 🔴 THE FALSE NEGATIVE AN EARLIER REVISION OF THE PREDICATE SHIPPED, found by
       * auditing the fix rather than the feature. Three ordinary steps:
       *   1. dev submits v1 → request R1, `appBlockId: null`, plus a draft listing;
       *   2. a moderator REJECTS R1 — which deliberately KEEPS the draft listing, because
       *      reject is the only "please fix this" signal this path has;
       *   3. dev re-submits, that version is approved → the approve stamps `appBlockId`
       *      onto the APPROVED request and onto the listing, and never touches R1.
       * R1 therefore has no block id while the listing has one. Keying on the REQUEST's id
       * alone blanked the Plays and media columns on the Rejected tab for the app's own
       * developer — correct before the ownership fix, broken by it, with nothing red.
       */
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_r1', slug: SLUG, appBlockId: null, submittedBy: { id: 7 } }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({
          slug: SLUG,
          appBlockId: 'apb_approved_later',
          userId: 7,
          metric: { openCount: 44 },
        }),
      ]);
      const result = await listRejectedRequests({ limit: 10 });
      expect(result.items[0].playCount).toBe(44);
      expect(result.items[0].iconUrl).toContain('icon-uuid');
    });

    it('🔴 an APPROVED row still shows its listing when the listing transition did not run', async () => {
      // The mirror image, and the moment it matters most: an approve whose draft→approved
      // listing transition was skipped (a still-scanning asset is the DESIGNED case, left
      // `draft` for re-review) leaves the request carrying the block id and the listing
      // not. The moderator looking at that row is the person who has to judge the pending
      // media, and the surface told them there was none.
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_a1', slug: SLUG, appBlockId: 'apb_mine', submittedBy: { id: 7 } }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: SLUG, appBlockId: null, userId: 7, metric: { openCount: 3 } }),
      ]);
      const result = await listApprovedRequests({ limit: 10 });
      expect(result.items[0].playCount).toBe(3);
    });

    it('🔴 POSITIVE CONTROL — the SAME shape with the ownership column matching DOES project', async () => {
      // Without this arm every assertion above is satisfied by a join that returns nothing
      // at all, which is the failure the fix would be indistinguishable from.
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_a', slug: SLUG, appBlockId: 'apb_mine' }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: SLUG, appBlockId: 'apb_mine', metric: { openCount: 31 } }),
      ]);
      const result = await listApprovedRequests({ limit: 10 });
      expect(result.items[0].playCount).toBe(31);
    });

    it("the never-approved OWNER case projects — the pre-approval draft is the app's own", async () => {
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_a', slug: SLUG, appBlockId: null, submittedBy: { id: 7 } }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: SLUG, appBlockId: null, userId: 7, metric: { openCount: 12 } }),
      ]);
      const result = await listPendingRequests({ limit: 10 });
      expect(result.items[0].playCount).toBe(12);
    });

    it('🔴 TWO decided rows on ONE released slug get their OWN verdicts, not a shared one', async () => {
      /**
       * 🔴 THE RESULT MAP IS KEYED ON THE REQUEST ID, AND ONLY THIS ARM CAN SEE IT. Every
       * other arm renders one row per page, so a slug-keyed map — which cannot hold two
       * verdicts for one slug — passes all of them. This is the released-slug shape the
       * whole predicate exists for: a freed slug puts two developers' decided rows on the
       * Rejected tab at once, and the stranger's row must not borrow the owner's listing.
       */
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_owner', slug: SLUG, appBlockId: null, submittedBy: { id: 7 } }),
        queueRow({ id: 'pubreq_stranger', slug: SLUG, appBlockId: null, submittedBy: { id: 999 } }),
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: SLUG, appBlockId: null, userId: 7, metric: { openCount: 77 } }),
      ]);
      const result = await listRejectedRequests({ limit: 10 });
      const byId = new Map(
        (result.items as { id: string; playCount: number | null; iconUrl: string | null }[]).map(
          (r) => [r.id, r]
        )
      );
      expect(byId.get('pubreq_owner')?.playCount, 'the OWNER row must show its listing').toBe(77);
      expect(
        byId.get('pubreq_stranger')?.playCount,
        "the STRANGER row must show nothing — it is another developer's listing"
      ).toBeNull();
      expect(byId.get('pubreq_stranger')?.iconUrl).toBeNull();
    });

    it('the query itself excludes non-onsite listings and revision shadows', async () => {
      // Belt only — a shadow's synthetic `rev-<ulid>` slug already cannot match an app
      // slug, and the kind term is re-tested in memory. Pinned so neither is dropped as
      // redundant without the other being checked.
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        queueRow({ id: 'pubreq_a', slug: SLUG }),
      ]);
      await listPendingRequests({ limit: 10 });
      const where = mockDbRead.appListing.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ kind: 'onsite', revisionOfId: null });
      // EXACT key set, so a fourth term cannot be added without a decision.
      expect(Object.keys(where).sort()).toEqual(['kind', 'revisionOfId', 'slug']);
    });
  });

  it('🔴 a present ICON is never substituted for a missing COVER', async () => {
    // `listingCoverUrl` takes a fallback argument and the shared projection passes `null`
    // deliberately: a moderator has to SEE that the listing has no cover. Nothing else in
    // these suites has an icon without a cover, so without this arm the fallback argument
    // could be changed to anything.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_nocover', slug: 'no-cover', submittedBy: { id: 7 } }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      listingRow({ slug: 'no-cover', icon: { url: 'icon-uuid' }, cover: null }),
    ]);
    const result = await listPendingRequests({ limit: 10 });
    expect(result.items[0].iconUrl).toContain('icon-uuid');
    expect(result.items[0].coverUrl).toBeNull();
  });

  it('a slug with NO listing yields nulls rather than throwing', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_b', slug: 'no-listing' }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([]);
    const result = await listPendingRequests({ limit: 10 });
    expect(result.items[0]).toMatchObject({ playCount: null, iconUrl: null, coverUrl: null });
  });

  it('🔴 a listing with no METRIC row is a genuine ZERO, not unknown', async () => {
    // The canonical rule this read goes through rather than re-deriving: `cardOpenCount`
    // says a missing metric row means "no plays recorded yet" ⇒ 0, and reserves `null` for
    // a listing whose count is UNMEASURABLE.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_c', slug: 'new-listing' }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      listingRow({ slug: 'new-listing', icon: null, cover: null, metric: null }),
    ]);
    const result = await listPendingRequests({ limit: 10 });
    expect(result.items[0].playCount).toBe(0);
  });

  it('a metric of ZERO stays zero', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'pubreq_d', slug: 'quiet-listing' }),
    ]);
    mockDbRead.appListing.findMany.mockResolvedValue([
      listingRow({ slug: 'quiet-listing', metric: { openCount: 0 } }),
    ]);
    const result = await listPendingRequests({ limit: 10 });
    expect(result.items[0].playCount).toBe(0);
  });

  it('🔴 ONE listing query per page, not one per row, and only for the rows RETURNED', async () => {
    // The `limit + 1` probe row must not be joined — and the join must never become an
    // N+1 on a 50-row mod queue.
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      queueRow({ id: 'r1', slug: 'app-1' }),
      queueRow({ id: 'r2', slug: 'app-2' }),
      queueRow({ id: 'r3', slug: 'app-3' }), // the probe row at limit=2
    ]);
    const result = await listPendingRequests({ limit: 2 });
    expect(mockDbRead.appListing.findMany).toHaveBeenCalledTimes(1);
    expect(mockDbRead.appListing.findMany.mock.calls[0][0].where.slug.in).toEqual([
      'app-1',
      'app-2',
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('r2');
  });

  it('no listing query at all when the page is empty', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    await listPendingRequests({ limit: 10 });
    expect(mockDbRead.appListing.findMany).not.toHaveBeenCalled();
  });

  it('🔴 ALL THREE list procs carry the projection, not just the two somebody tested', async () => {
    // Looped over the real exports.
    const procs = [
      ['pending', listPendingRequests],
      ['approved', listApprovedRequests],
      ['rejected', listRejectedRequests],
    ] as const;
    for (const [name, proc] of procs) {
      mockDbRead.appListing.findMany.mockClear();
      mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
        {
          ...queueRow({ id: `pubreq_${name}`, slug: `app-${name}`, appBlockId: `apb_${name}` }),
          reviewedAt: new Date('2026-03-02T00:00:00Z'),
          approvalNotes: null,
          rejectionReason: null,
          deployState: 'live',
          deployDetail: null,
          deployUpdatedAt: null,
          reviewedBy: { id: 9, username: 'mod', deletedAt: null, image: null },
        },
      ]);
      mockDbRead.appListing.findMany.mockResolvedValue([
        listingRow({ slug: `app-${name}`, appBlockId: `apb_${name}`, metric: { openCount: 55 } }),
      ]);
      const result = await proc({ limit: 10 });
      expect(result.items[0].playCount, `${name} must carry playCount`).toBe(55);
      expect(result.items[0].iconUrl, `${name} must carry iconUrl`).toContain('icon-uuid');
    }
  });
});
