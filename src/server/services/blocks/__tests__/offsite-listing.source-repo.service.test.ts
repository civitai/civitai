import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  OFFSITE_UNCOMPARED_APPLY_FIELDS,
  computeListingRevisionDrift,
  identicalAssetsNotice,
  revisionApplyScope,
  uncomparedApplyFieldsSentence,
} from '~/components/Apps/listingRevisionDrift';
import { SOURCE_REPO_UNAVAILABLE_MESSAGE } from '~/server/services/blocks/app-listing-source-repo.service';

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
 *
 *   4. THE MANUAL-APPLY COLUMN. `app_listings.source_repo_url` is applied by hand, so
 *      every path here has to behave while it does not exist. The two halves are not the
 *      same rule: a write the SYSTEM originates OMITS the key, a write an AUTHOR
 *      originates REFUSES with a message. Getting the second one wrong gives an author a
 *      P2022 500 naming a database column — and on an approved listing it lands after a
 *      shadow revision has been minted, so it also leaves an orphan draft behind.
 *
 *   5. WHICH DATABASE ANSWERED. The clone reads the column on the PRIMARY, not the
 *      replica, because a replica saying "absent" while the primary says "present" makes
 *      the approve write `{sourceRepoUrl: null}` and silently delete a live public link.
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

const {
  approveExternalRequest,
  beginListingRevision,
  buildListingPatchData,
  submitExternalListing,
  updateListing,
} = await import('~/server/services/blocks/offsite-listing.service');

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

/** Does this `findUnique` call belong to the guarded source-repo read? */
function isSourceRepoProbe(args: { select?: Record<string, unknown> }): boolean {
  const select = args?.select ?? {};
  return select.sourceRepoUrl === true && Object.keys(select).length === 1;
}

/** The Prisma error a `select` naming a column the database does not have raises. */
function missingColumnError() {
  return Object.assign(
    new Error('The column `app_listings.source_repo_url` does not exist in the current database.'),
    { code: 'P2022' }
  );
}

/**
 * Arm the PRIMARY (`dbWrite`) source-repo read, which `beginListingRevision` uses to
 * clone the parent's link and `applyApprovedRevision` uses to probe the column.
 *
 * 🔴 `dbWrite`, not `dbRead`, IS THE ASSERTION HERE, not an implementation detail: if
 * the clone ever goes back to reading the replica, this fake never answers and the
 * shadow is created with `sourceRepoUrl: null` — which is exactly the silent-clear the
 * primary read exists to prevent.
 */
function armPrimarySourceRepo(value: string | null = LIVE_REPO) {
  mockWrite.appListing.findUnique.mockImplementation(
    async (args: { where: { id: string }; select?: Record<string, unknown> }) =>
      isSourceRepoProbe(args) ? { sourceRepoUrl: value } : null
  );
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
  armPrimarySourceRepo();
}

/**
 * The manual-apply migration has NOT run: every guarded read of the column — on the
 * replica AND on the primary — raises P2022, exactly as Prisma does against a database
 * missing it. Every OTHER read of the row still works, which is the whole point: the
 * pre-existing flows must be unaffected.
 */
function armColumnMissing(parent: Row = approvedParent()) {
  mockRead.appListing.findUnique.mockImplementation(
    async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
      if (isSourceRepoProbe(args)) throw missingColumnError();
      return parent;
    }
  );
  mockWrite.appListing.findUnique.mockImplementation(
    async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
      if (isSourceRepoProbe(args)) throw missingColumnError();
      return null;
    }
  );
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

/** The column exists — the ordinary case for the patch-shape claims below. */
const COLUMN_PRESENT = { sourceRepoAvailable: true } as const;

describe('buildListingPatchData — omitted ≠ explicit null ≠ a value', () => {
  it('OMITTED leaves the column untouched (the key is absent from the write)', () => {
    const data = buildListingPatchData({ name: 'Renamed' }, COLUMN_PRESENT);
    // ABSENCE is the assertion — a `{sourceRepoUrl: null}` here would silently CLEAR
    // the live link on every unrelated rename.
    expect('sourceRepoUrl' in data).toBe(false);
    expect(data).toEqual({ name: 'Renamed' });
  });

  it('an explicit NULL clears it', () => {
    const data = buildListingPatchData({ sourceRepoUrl: null }, COLUMN_PRESENT);
    expect(data).toEqual({ sourceRepoUrl: null });
    expect('sourceRepoUrl' in data).toBe(true);
  });

  it('a valid value is stored NORMALISED, not verbatim', () => {
    // The author pasted the clone URL with a trailing slash; what lands in the column is
    // the canonical form, because that is what the material-change check compares.
    const data = buildListingPatchData(
      { sourceRepoUrl: 'https://GITHUB.com/civitai/cool-app.git/' },
      COLUMN_PRESENT
    );
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
    expect(() => buildListingPatchData({ sourceRepoUrl }, COLUMN_PRESENT)).toThrow(TRPCError);
    try {
      buildListingPatchData({ sourceRepoUrl }, COLUMN_PRESENT);
    } catch (e) {
      expect((e as TRPCError).code).toBe('BAD_REQUEST');
      expect((e as TRPCError).message).toContain('sourceRepoUrl');
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. buildListingPatchData vs the MANUAL-APPLY column
// ---------------------------------------------------------------------------

describe('🔴 the refusal an author actually reads', () => {
  it('is pinned as a LITERAL, not against the constant that defines it', () => {
    // 🔴 THIS TEST EXISTS BECAUSE ITS ABSENCE WAS MEASURED. Every other assertion in
    // this file compares a thrown message against `SOURCE_REPO_UNAVAILABLE_MESSAGE` —
    // imported from the module under test — so a mutant that rewrote that constant to
    // the string "nope" moved every expectation with it and SURVIVED a fully green
    // suite. An expectation derived from the implementation it tests is not an
    // expectation. This is the one assertion the constant cannot satisfy by changing.
    expect(SOURCE_REPO_UNAVAILABLE_MESSAGE).toBe(
      'The source repository link is not available on this environment yet. Leave the field empty and try again later.'
    );
  });

  it('names the field in the author’s vocabulary and leaks no database detail', () => {
    // The product requirement behind the guard: what replaced the P2022 500 must not
    // read like one. `sourceRepoUrl`, `source_repo_url`, `P2022` and the word "column"
    // are all things an author has no way to act on and should never be shown.
    expect(SOURCE_REPO_UNAVAILABLE_MESSAGE).toContain('source repository');
    for (const leak of ['sourceRepoUrl', 'source_repo_url', 'P2022', 'column', 'Prisma']) {
      expect(SOURCE_REPO_UNAVAILABLE_MESSAGE).not.toContain(leak);
    }
  });
});

describe('🔴 buildListingPatchData REFUSES to write the column before the migration runs', () => {
  it.each([
    ['a value', LIVE_REPO as string | null],
    ['an explicit null', null as string | null],
  ])(
    'PRECONDITION_FAILED for %s — Prisma raises the same P2022 for either instruction',
    (_label, sourceRepoUrl) => {
      let thrown: TRPCError | undefined;
      try {
        buildListingPatchData({ sourceRepoUrl }, { sourceRepoAvailable: false });
      } catch (e) {
        thrown = e as TRPCError;
      }
      expect(thrown).toBeInstanceOf(TRPCError);
      // 🔴 THE CODE AND THE MESSAGE, not just "it threw". `BAD_REQUEST` is what an
      // invalid URL produces; a guard that collapsed the two would tell the author their
      // perfectly good link is malformed and send them editing it forever.
      expect(thrown?.code).toBe('PRECONDITION_FAILED');
      expect(thrown?.message).toBe(SOURCE_REPO_UNAVAILABLE_MESSAGE);
    }
  );

  it('a patch that does NOT name the field is unaffected — an author who left it empty still saves', () => {
    // The bound this guard must not overreach: an unapplied migration cannot be allowed
    // to break every unrelated edit, which is the whole posture of this feature.
    const data = buildListingPatchData(
      { name: 'Renamed', tagline: 'new tagline' },
      { sourceRepoAvailable: false }
    );
    expect(data).toEqual({ name: 'Renamed', tagline: 'new tagline' });
  });

  it('FAILS CLOSED when a caller omits the flag entirely', () => {
    // The defect this parameter exists for was a call site that never passed one. If a
    // future one slips past the compiler (a test, an `any`, a JS consumer), the answer
    // must be a refusal, never an unguarded write.
    expect(() =>
      buildListingPatchData({ sourceRepoUrl: LIVE_REPO }, {} as { sourceRepoAvailable: boolean })
    ).toThrow(SOURCE_REPO_UNAVAILABLE_MESSAGE);
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

// ---------------------------------------------------------------------------
// 5. The MANUAL-APPLY column, end to end on the AUTHOR paths
//
// 🔴 The claim under test is the one the migration file and the PR body make out
// loud: deploying this code before a human runs the `ALTER TABLE` breaks nothing.
// "Breaks nothing" has two halves that are easy to confuse —
//   * an author who does NOT use the field must be completely unaffected, and
//   * an author who DOES must get a refusal that names the field, never a P2022 500
//     naming a database column, and never a silent drop of what they typed.
// Both halves are asserted, in both directions, because a guard that satisfies only
// the first is indistinguishable from no guard at all on the paths that matter.
// ---------------------------------------------------------------------------

const CLIENT_ID = 'oauth-client-1';

function submitInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'brand-new-app',
    name: 'Brand New App',
    connectClientId: CLIENT_ID,
    requestedScopes: 0,
    scopeJustifications: {},
    contentRating: 'g',
    ...overrides,
  } as Parameters<typeof submitExternalListing>[0]['input'];
}

/** Everything `submitExternalListing` needs to reach its transaction. */
function armSubmit() {
  mockRead.oauthClient.findUnique.mockResolvedValue({
    id: CLIENT_ID,
    userId: OWNER,
    allowedScopes: 0,
  });
  mockRead.appListingPublishRequest.count.mockResolvedValue(0);
  mockRead.appBlock.findFirst.mockResolvedValue(null);
  mockWrite.appBlock.findFirst.mockResolvedValue(null);
  mockWrite.appListingPublishRequest.create.mockImplementation(
    async (a: { data: unknown }) => a.data
  );
}

describe('🔴 submitExternalListing and the unapplied migration', () => {
  it('an author who SUPPLIES a repo gets PRECONDITION_FAILED — and NOTHING is created', async () => {
    // Before this guard the create named the column and Prisma answered P2022: the
    // author saw a 500 quoting `app_listings.source_repo_url`, which is neither
    // actionable nor safe to show.
    armSubmit();
    mockRead.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (isSourceRepoProbe(args)) throw missingColumnError();
        return null;
      }
    );
    mockWrite.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (isSourceRepoProbe(args)) throw missingColumnError();
        return null;
      }
    );

    let thrown: TRPCError | undefined;
    try {
      await submitExternalListing({
        input: submitInput({ sourceRepoUrl: LIVE_REPO }),
        userId: OWNER,
      });
    } catch (e) {
      thrown = e as TRPCError;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect(thrown?.code).toBe('PRECONDITION_FAILED');
    expect(thrown?.message).toBe(SOURCE_REPO_UNAVAILABLE_MESSAGE);
    // 🔴 The refusal lands BEFORE any side effect. A listing row plus a pending publish
    // request created and then abandoned would put a phantom submission into the mod
    // queue and count against the author's outstanding-submission cap.
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('🔴 an author who leaves it EMPTY submits normally — the guard does not widen', async () => {
    // The bound. This is the case the whole manual-apply posture exists to protect: a
    // brand-new optional field must not break the pre-existing submit for everyone else.
    armSubmit();
    mockRead.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (isSourceRepoProbe(args)) throw missingColumnError();
        return null;
      }
    );
    mockWrite.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (isSourceRepoProbe(args)) throw missingColumnError();
        return null;
      }
    );

    const res = await submitExternalListing({ input: submitInput(), userId: OWNER });
    expect(res.slug).toBe('brand-new-app');
    const created = (
      mockWrite.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    // OMITTED, not `null`: naming the column at all is what raises P2022.
    expect('sourceRepoUrl' in created).toBe(false);
  });

  it('POSITIVE CONTROL: with the column present the same submit STORES the canonical value', async () => {
    // Without this the two cases above are equally satisfied by a guard that refuses
    // every source-repo submit forever, which would be a broken feature reading green.
    armSubmit();
    mockRead.appListing.findUnique.mockResolvedValue(null);
    armPrimarySourceRepo(null);

    await submitExternalListing({
      input: submitInput({ sourceRepoUrl: `${LIVE_REPO}.git/` }),
      userId: OWNER,
    });
    const created = (
      mockWrite.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(created.sourceRepoUrl).toBe(LIVE_REPO);
  });
});

describe('🔴 updateListing and the unapplied migration', () => {
  it('an APPROVED listing: PRECONDITION_FAILED, and NO ORPHAN SHADOW is minted', async () => {
    // 🔴 THE ORPHAN IS THE POINT, not just the status code. A source-repo change is
    // MATERIAL, so the approved path opens a shadow revision BEFORE it builds the patch
    // data — a refusal raised inside the patch builder would land after the shadow
    // exists, leaving the author a revision draft they never asked for and a listing
    // that reads as "pending re-review" for an edit that never applied.
    armColumnMissing();
    armShadowOpen();
    // …then re-break the primary read, which armShadowOpen() arms for the healthy case.
    mockWrite.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (isSourceRepoProbe(args)) throw missingColumnError();
        return null;
      }
    );

    let thrown: TRPCError | undefined;
    try {
      await updateListing({
        listingId: 'apl_parent',
        patch: { sourceRepoUrl: 'https://gitlab.com/someone/other-app' },
        userId: OWNER,
      });
    } catch (e) {
      thrown = e as TRPCError;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect(thrown?.code).toBe('PRECONDITION_FAILED');
    expect(thrown?.message).toBe(SOURCE_REPO_UNAVAILABLE_MESSAGE);
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('a DRAFT listing (the in-place path): PRECONDITION_FAILED, and no write', async () => {
    armColumnMissing(approvedParent({ status: 'draft' }));
    await expect(
      updateListing({
        listingId: 'apl_parent',
        patch: { sourceRepoUrl: LIVE_REPO },
        userId: OWNER,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('🔴 an unrelated edit on the SAME listing still applies — the guard does not widen', async () => {
    // The bound again, on the edit path: the column being absent must not make every
    // tagline fix fail. Note the patch names no material field, so this is the in-place
    // branch and the write must actually happen.
    armColumnMissing(approvedParent({ status: 'draft' }));
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { tagline: 'a quick copy edit' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { tagline: 'a quick copy edit' },
    });
  });
});

// ---------------------------------------------------------------------------
// 6. WHICH DATABASE ANSWERED — the replica/primary split that silently CLEARS a link
// ---------------------------------------------------------------------------

describe('🔴 beginListingRevision resolves the source repo on the PRIMARY, not the replica', () => {
  it('a replica that cannot see the column does NOT cost the parent its live link', async () => {
    // The failure this pins, step by step: `loadOwnedEditableListing` probes `dbRead`
    // during the seconds after the manual `ALTER TABLE` when the replica has not caught
    // up, so it reports `available: false`. A clone that trusted that omits the column,
    // the shadow's value reads back as NULL, and `applyApprovedRevision` — which probes
    // the PRIMARY and sees the column fine — copies that NULL onto the parent. The
    // public Source row disappears with no error, no moderator-visible diff, and no way
    // to tell it from "the author removed it".
    mockRead.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (isSourceRepoProbe(args)) throw missingColumnError(); // the LAGGING replica
        return approvedParent();
      }
    );
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });
    armPrimarySourceRepo(LIVE_REPO); // the PRIMARY has it

    await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });
    const created = (
      mockWrite.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(created.sourceRepoUrl).toBe(LIVE_REPO);
  });

  it('when the PRIMARY has no column either, the key is OMITTED — never written as null', async () => {
    // The other direction, and the reason this is a fragment rather than a value: a
    // `{sourceRepoUrl: null}` against a missing column raises P2022 INSIDE the clone's
    // transaction and rolls the whole revision-open back.
    armColumnMissing();
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });
    mockWrite.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (isSourceRepoProbe(args)) throw missingColumnError();
        return null;
      }
    );

    await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });
    const created = (
      mockWrite.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect('sourceRepoUrl' in created).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. The revision APPROVE transaction must never name a column that is not there
// ---------------------------------------------------------------------------

describe('🔴 applyApprovedRevision asks about the column BEFORE opening its transaction', () => {
  /** Arm a pending offsite REVISION approve (`apl_shadow` → `apl_parent`). */
  function armApproveRevision() {
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
  }

  it('with the column absent, exactly ONE source-repo query is issued and it is the pre-tx probe', async () => {
    // 🔴 WHY THE CALL COUNT IS THE ASSERTION. The guarded read swallows P2022 at the
    // application level, but PostgreSQL aborts a TRANSACTION on any statement error and
    // Prisma issues no savepoints — so a missing-column read inside the apply would leave
    // every following statement failing with 25P02 and take the whole revision approve
    // down, long after the error it "handled" was forgotten. Asking outside the
    // transaction means the transaction never mentions the column at all.
    armApproveRevision();
    mockWrite.appListing.findUnique.mockImplementation(
      async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
        if (isSourceRepoProbe(args)) throw missingColumnError();
        return args.where.id === 'apl_shadow'
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
              connectClientId: null,
              connectRequestedScopes: null,
              connectScopeJustifications: null,
              connectClient: null,
              iconId: 5,
              coverId: 6,
            }
          : null;
      }
    );

    await approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD });

    const repoQueries = mockWrite.appListing.findUnique.mock.calls.filter((c) =>
      isSourceRepoProbe(c[0] as { select?: Record<string, unknown> })
    );
    expect(repoQueries).toHaveLength(1);
    // …and it is the ROW-LESS probe, not the shadow read the transaction would have done.
    expect((repoQueries[0][0] as { where: { id: string } }).where.id).not.toBe('apl_shadow');

    // The apply still succeeds, with the column simply absent from the write.
    const parentUpdate = mockWrite.appListing.update.mock.calls.find(
      (c) => (c[0] as { where: { id: string } }).where.id === 'apl_parent'
    );
    expect(parentUpdate).toBeDefined();
    expect('sourceRepoUrl' in (parentUpdate![0] as { data: Record<string, unknown> }).data).toBe(
      false
    );
  });
});
