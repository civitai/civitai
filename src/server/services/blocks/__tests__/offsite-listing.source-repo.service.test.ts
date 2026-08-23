import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  OFFSITE_UNCOMPARED_APPLY_FIELDS,
  computeListingRevisionDrift,
  identicalAssetsNotice,
  revisionApplyScope,
  uncomparedApplyFieldsSentence,
} from '~/components/Apps/listingRevisionDrift';

/**
 * Off-site `sourceRepoUrl` — the patch builder, the MATERIAL-change classification, and
 * the shadow-revision round trip.
 *
 * Three claims, each of which has a specific way of being wrong:
 *
 *   1. PATCH SHAPE. Omitted / explicit-null / a value are three different instructions
 *      (untouched / clear / set). Collapsing any two silently makes a field unclearable
 *      or clobbers it on every unrelated edit.
 *
 *   2. MATERIAL BY CANONICAL FORM. A changed repo link must re-enter moderator review;
 *      a cosmetically-different spelling of the SAME repo must not. Comparing raw
 *      strings gets the second one wrong and queues pointless reviews.
 *
 *   3. THE ROUND TRIP. `beginListingRevision` must carry the link onto the shadow (or
 *      approving a revision that never touched it would CLEAR it), `applyApprovedRevision`
 *      must copy it back, and `listingRevisionDrift` must NAME it — the panel exists
 *      because an incomplete apply-field list once told a moderator that a
 *      scope-changing revision "changes nothing".
 */

type Row = Record<string, unknown> & { id: string };

const { seq } = vi.hoisted(() => ({ seq: { n: 0 } }));

// 🔴 THE CANONICAL `~/server/db/client` MOCK, not a per-file `vi.mock`. With
// `isolate: false` a per-file registration freezes THIS file's mock shape into every
// later file in the same worker — `no-direct-shared-module-mock.test.ts` is the ratchet
// that enforces it. `dbRead` and `dbWrite` are DISTINCT here, which matters: the guarded
// source-repo read goes through `dbRead` on the author paths and through the interactive
// `tx` (the write client) inside `applyApprovedRevision`.
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

const { approveExternalRequest, beginListingRevision, buildListingPatchData, updateListing } =
  await import('~/server/services/blocks/offsite-listing.service');

const OWNER = 42;
const MOD = 7;

const LIVE_REPO = 'https://github.com/civitai/cool-app';

function approvedParent(overrides: Partial<Row> = {}): Row {
  return {
    id: 'apl_parent',
    kind: 'offsite',
    slug: 'cool-app',
    status: 'approved',
    userId: OWNER,
    revisionOfId: null,
    name: 'Cool App',
    tagline: 'the tagline',
    description: 'the description',
    category: 'utility',
    contentRating: 'g',
    externalUrl: 'https://cool.example.com/app',
    sourceRepoUrl: LIVE_REPO,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 1,
    coverId: 2,
    ...overrides,
  };
}

/**
 * Arm the shadow-open path: no existing shadow on the replica, no in-tx race, and the
 * post-tx winning-shadow re-read returns the row `beginListingRevision` minted.
 * (Mirrors the staging the sibling `offsite-listing.edit.service.test.ts` uses.)
 */
function armShadowOpen() {
  mockRead.appListing.findFirst.mockResolvedValue(null);
  mockWrite.appListing.findFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 'apl_new_1' });
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  // Defaults the code under test needs but the canonical mock cannot guess. Everything
  // else auto-vivifies to a plausible empty answer (findUnique → null, findMany → []),
  // and `$transaction` runs its callback with `dbWrite` — which is what makes
  // `applyApprovedRevision`'s in-tx reads land on the same fake the test arms.
  mockWrite.appListing.create.mockImplementation(async (a: { data: unknown }) => a.data);
  mockWrite.appListing.update.mockImplementation(async (a: { data: unknown }) => a.data);
  mockWrite.appListing.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.appListing.deleteMany.mockResolvedValue({ count: 1 });
  mockWrite.appListingScreenshot.createMany.mockResolvedValue({ count: 0 });
  mockWrite.appListingScreenshot.updateMany.mockResolvedValue({ count: 0 });
  mockWrite.appListingScreenshot.deleteMany.mockResolvedValue({ count: 0 });
  mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  // The go-live scan-clean gate echoes every queried image id back as `Scanned`.
  mockWrite.image.findMany.mockImplementation(
    async (args: { where?: { id?: { in?: number[] } } }) =>
      (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion: 'Scanned' }))
  );
});

// ---------------------------------------------------------------------------
// 1. buildListingPatchData
// ---------------------------------------------------------------------------

describe('buildListingPatchData — omitted ≠ explicit null ≠ a value', () => {
  it('OMITTED leaves the column untouched (the key is absent from the write)', () => {
    const data = buildListingPatchData({ name: 'Renamed' });
    // ABSENCE is the assertion — a `{sourceRepoUrl: null}` here would silently CLEAR
    // the live link on every unrelated rename.
    expect('sourceRepoUrl' in data).toBe(false);
    expect(data).toEqual({ name: 'Renamed' });
  });

  it('an explicit NULL clears it', () => {
    const data = buildListingPatchData({ sourceRepoUrl: null });
    expect(data).toEqual({ sourceRepoUrl: null });
    expect('sourceRepoUrl' in data).toBe(true);
  });

  it('a valid value is stored NORMALISED, not verbatim', () => {
    // The author pasted the clone URL with a trailing slash; what lands in the column is
    // the canonical form, because that is what the material-change check compares.
    const data = buildListingPatchData({
      sourceRepoUrl: 'https://GITHUB.com/civitai/cool-app.git/',
    });
    expect(data).toEqual({ sourceRepoUrl: LIVE_REPO });
  });

  it.each([
    ['http', 'http://github.com/o/r'],
    ['a non-allowlisted host', 'https://gist.github.com/o/r'],
    ['a deep path', 'https://github.com/o/r/tree/main'],
    ['credentials', 'https://u:p@github.com/o/r'],
  ])('REJECTS %s with a BAD_REQUEST rather than storing it', (_label, sourceRepoUrl) => {
    // Defence in depth: this function is exported and unit-tested directly, so it does
    // not trust the zod boundary to have run.
    expect(() => buildListingPatchData({ sourceRepoUrl })).toThrow(TRPCError);
    try {
      buildListingPatchData({ sourceRepoUrl });
    } catch (e) {
      expect((e as TRPCError).code).toBe('BAD_REQUEST');
      expect((e as TRPCError).message).toContain('sourceRepoUrl');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. MATERIAL classification (via updateListing on an APPROVED listing)
// ---------------------------------------------------------------------------

describe('a source-repo change is MATERIAL — it re-enters moderator review', () => {
  it('a DIFFERENT repo stages a shadow revision (requiresReview)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armShadowOpen();
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { sourceRepoUrl: 'https://gitlab.com/someone-else/other-app' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(true);
    expect(res.shadowId).not.toBeNull();
    // The LIVE parent is untouched — the edit went onto the shadow.
    const parentWrites = mockWrite.appListing.update.mock.calls.filter(
      (c) => (c[0] as { where: { id: string } }).where.id === 'apl_parent'
    );
    expect(parentWrites).toHaveLength(0);
  });

  it('CLEARING a live repo is material too (a link disappearing is a change)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armShadowOpen();
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { sourceRepoUrl: null },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(true);
  });

  it.each([
    ['a trailing slash', `${LIVE_REPO}/`],
    ['a trailing .git', `${LIVE_REPO}.git`],
    ['an uppercase host', 'https://GITHUB.COM/civitai/cool-app'],
    ['a query string', `${LIVE_REPO}?tab=readme`],
    ['surrounding whitespace', `  ${LIVE_REPO}  `],
  ])(
    '🔴 %s is the SAME repo — applied in place, NOT queued for re-review',
    async (_label, sourceRepoUrl) => {
      // Raw-string comparison would classify each of these as material and push the
      // author into a "pending re-review" state for an edit that changed nothing.
      mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
      // 🔴 THE SHADOW PATH IS ARMED even though this case must NOT take it. Without
      // that, a mutant that wrongly classifies these as material dies on
      // "failed to open a revision draft" — an infrastructural error from an unarmed
      // fake, not this guard's own assertion. Armed, the material path SUCCEEDS, and
      // the only thing that can fail is `requiresReview` being wrong.
      armShadowOpen();
      const res = await updateListing({
        listingId: 'apl_parent',
        patch: { sourceRepoUrl },
        userId: OWNER,
      });
      expect(res.requiresReview).toBe(false);
      expect(res.shadowId).toBeNull();
      // …and the in-place write stores the canonical form regardless of the spelling.
      expect(mockWrite.appListing.update).toHaveBeenCalledWith({
        where: { id: 'apl_parent' },
        data: { sourceRepoUrl: LIVE_REPO },
      });
    }
  );

  it('an INVALID value is treated as material (it is not "unchanged")', async () => {
    // It will be rejected downstream by buildListingPatchData; the point is that it can
    // never take the trivial IN-PLACE path, which would write an unreviewed value to the
    // live row if the rejection were ever relaxed.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armShadowOpen();
    await expect(
      updateListing({
        listingId: 'apl_parent',
        patch: { sourceRepoUrl: 'https://gist.github.com/x/y' },
        userId: OWNER,
      })
    ).rejects.toThrow(TRPCError);
    // A shadow was opened (the material branch) — and the parent was never written.
    const parentWrites = mockWrite.appListing.update.mock.calls.filter(
      (c) => (c[0] as { where: { id: string } }).where.id === 'apl_parent'
    );
    expect(parentWrites).toHaveLength(0);
  });

  it('a listing with NO repo, patched to null, is NOT material (nothing to clear)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ sourceRepoUrl: null }));
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { sourceRepoUrl: null, tagline: 'just copy' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The shadow round trip
// ---------------------------------------------------------------------------

describe('the revision round trip carries the source repo', () => {
  it('🔴 beginListingRevision COPIES it onto the shadow — otherwise approving CLEARS it', async () => {
    // `applyApprovedRevision` copies the shadow's value onto the parent unconditionally.
    // A shadow cloned WITHOUT the column therefore reads as "the author removed the
    // link", and a revision that only changed an icon would silently delete it.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armShadowOpen();
    await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });

    const created = (
      mockWrite.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(created.revisionOfId).toBe('apl_parent');
    expect(created.sourceRepoUrl).toBe(LIVE_REPO);
  });

  it('applyApprovedRevision COPIES the shadow’s value onto the live parent', async () => {
    const SHADOW_REPO = 'https://codeberg.org/new-org/new-app';
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_rev',
      status: 'pending',
      kind: 'offsite',
      slug: 'cool-app',
      appListingId: 'apl_shadow',
    });
    mockRead.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'apl_parent')
        return { id: 'apl_parent', slug: 'cool-app', status: 'approved', kind: 'offsite' };
      if (args.where.id === 'apl_shadow')
        return {
          id: 'apl_shadow',
          status: 'draft',
          externalUrl: 'https://cool.example.com/app',
          iconId: 5,
          coverId: 6,
          revisionOfId: 'apl_parent',
        };
      return null;
    });
    mockWrite.appListingScreenshot.findMany.mockResolvedValue([{ imageId: 10 }]);
    mockWrite.image.findMany.mockResolvedValue([
      { id: 5, nsfwLevel: 1, ingestion: 'Scanned' },
      { id: 6, nsfwLevel: 1, ingestion: 'Scanned' },
      { id: 10, nsfwLevel: 1, ingestion: 'Scanned' },
    ]);
    mockWrite.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === 'apl_shadow'
        ? {
            id: 'apl_shadow',
            status: 'draft',
            revisionOfId: 'apl_parent',
            name: 'Cool App',
            tagline: 't',
            description: 'd',
            category: 'utility',
            contentRating: 'g',
            externalUrl: 'https://cool.example.com/app',
            sourceRepoUrl: SHADOW_REPO,
            connectClientId: null,
            connectRequestedScopes: null,
            connectScopeJustifications: null,
            connectClient: null,
            iconId: 5,
            coverId: 6,
          }
        : null
    );

    await approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD });

    const parentUpdate = mockWrite.appListing.update.mock.calls.find(
      (c) => (c[0] as { where: { id: string } }).where.id === 'apl_parent'
    );
    expect(parentUpdate).toBeDefined();
    expect((parentUpdate![0] as { data: Record<string, unknown> }).data.sourceRepoUrl).toBe(
      SHADOW_REPO
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The moderator drift panel must NAME the field
// ---------------------------------------------------------------------------

describe('🔴 listingRevisionDrift NAMES the source repo among the fields an approve copies', () => {
  it('the field is in OFFSITE_UNCOMPARED_APPLY_FIELDS', () => {
    // Asserted against the CONSTANT, not a hand-written list, so a future field added to
    // the apply set and omitted here cannot pass by matching a stale literal.
    expect([...OFFSITE_UNCOMPARED_APPLY_FIELDS]).toContain('source repository');
  });

  it('the panel’s header sentence names it (derived from the constant, not re-typed)', () => {
    const sentence = uncomparedApplyFieldsSentence();
    for (const field of OFFSITE_UNCOMPARED_APPLY_FIELDS) {
      expect(sentence).toContain(field);
    }
    expect(sentence).toContain('source repository');
  });

  it('an OFF-SITE revision can NEVER be reported as "approving changes nothing"', () => {
    // This is the structural guarantee `noOpApproval` exists for: the asset comparison
    // covers only part of an offsite apply set, and `sourceRepoUrl` is now in the part
    // it does not cover.
    const identical = {
      iconId: 1,
      coverId: 2,
      screenshotImageIds: [10],
      screenshotCaptions: [null],
    };
    const drift = computeListingRevisionDrift(identical, identical, {
      applyScope: revisionApplyScope('offsite'),
    });
    expect(drift.assetsChanged).toBe(false);
    expect(drift.noOpApproval).toBe(false);
    // …and the notice a moderator reads names the source repo explicitly.
    expect(identicalAssetsNotice(drift)).toContain('source repository');
    expect(identicalAssetsNotice(drift)).not.toContain('approving changes nothing');
  });

  it('an ONSITE revision is still a legitimate no-op (assets-only apply set) — control', () => {
    // The control for the above: `noOpApproval` is not hardcoded to false.
    const identical = {
      iconId: 1,
      coverId: 2,
      screenshotImageIds: [10],
      screenshotCaptions: [null],
    };
    const drift = computeListingRevisionDrift(identical, identical, {
      applyScope: revisionApplyScope('onsite'),
    });
    expect(drift.noOpApproval).toBe(true);
    expect(drift.uncomparedApplyFields).toEqual([]);
  });
});
