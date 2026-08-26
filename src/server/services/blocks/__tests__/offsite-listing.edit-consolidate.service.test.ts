import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteRequestError,
  getMyListingForEdit,
  updateRevisionDraft,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * W13 — dual-mode edit CONSOLIDATION service tests: `getMyListingForEdit` (the
 * owner-gated prefill read: scalars + assets + status + hasPendingRevision) and
 * `updateRevisionDraft` (the scalar write to an owned draft shadow).
 *
 * 🔴 SECURITY (audit #3010): for an APPROVED listing, `getMyListingForEdit` resolves
 * the SHADOW server-side (idempotent `beginListingRevision`) and returns
 * `effectiveId = shadowId` + the SHADOW's asset rows — NEVER the live parent's row
 * ids. These tests pin BOTH the reuse (existing shadow) and the create (no prior
 * shadow — the removal-bypass bug case) paths, asserting the edit-view read targets
 * the shadow and the returned screenshot rows are the shadow's. All DB deps mocked;
 * `getEdgeUrl` + the id gens are stubbed.
 */

const { mockRead, mockWrite, seq } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      update: vi.fn(async (args: { data: unknown }) => args.data),
    },
    // 🔴 SEATS ARE LISTING-KEYED, so EVERY non-owner path now consults this table —
    // there is no longer an "this listing has no AppBlock" short-circuit to skip it.
    // Default: no seat, i.e. exactly the owner-only behaviour these cases assert.
    appCollaborator: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appListingScreenshot: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    appListingPublishRequest: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    oauthClient: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    // The last-moderation-event lookup that separates an OWNER self-unpublish from a
    // MODERATOR takedown on a `removed` listing (both write `status='removed'`). Default
    // NO event ⇒ not owner-unpublish ⇒ still FORBIDDEN, which is what the `removed` case
    // below asserts. Owner-unpublish is covered in
    // `offsite-listing.owner-unpublish-editable.service.test.ts`.
    appListingModerationEvent: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  });
  const mockRead = makeClient();
  const mockWrite = makeClient() as ReturnType<typeof makeClient> & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  mockWrite.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  return { mockRead, mockWrite, seq: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => `edge:${url}` }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

/** The `editableListingSelect` shape (owner check + state). */
function ownedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apl_parent',
    kind: 'offsite',
    slug: 'vitrine',
    status: 'draft',
    userId: 7,
    revisionOfId: null,
    name: 'Vitrine',
    tagline: 'A gallery',
    description: 'desc',
    category: 'utility',
    contentRating: 'g',
    externalUrl: 'https://vitrine.civitai.com/',
    connectClientId: null,
    iconId: 10,
    coverId: 20,
    ...overrides,
  };
}

/** The `loadListingEditView` shape (scalars + assets w/ image urls). `ssRowId` marks
 *  which listing's screenshot rows these are (parent vs shadow) so tests can assert. */
function editViewRow(ssRowId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Vitrine',
    tagline: 'A gallery',
    description: 'desc',
    category: 'utility',
    contentRating: 'g',
    externalUrl: 'https://vitrine.civitai.com/',
    iconId: 10,
    coverId: 20,
    icon: { url: 'icon-key' },
    cover: { url: 'cover-key' },
    screenshots: [
      { id: ssRowId, imageId: 30, order: 0, caption: 'cap', image: { url: 'shot-key' } },
    ],
    ...overrides,
  };
}

/**
 * Route `appListing.findUnique` by `select` shape (owner check vs edit-view) and, for
 * the edit-view, by `where.id` so the shadow's view carries shadow row ids. Wired on
 * BOTH pools: the edit-view read of a SHADOW goes to the PRIMARY (`dbWrite`) — see the
 * replica-lag test below.
 *
 * `replicaLagsOn` makes the REPLICA miss on the given ids while the PRIMARY still
 * serves them — real replication lag.
 */
function wireFindUnique(
  owned: unknown,
  viewByListingId: Record<string, unknown>,
  opts: { replicaLagsOn?: string[] } = {}
) {
  const impl = (isReplica: boolean) => async (args: unknown) => {
    const a = args as { select?: Record<string, unknown>; where?: { id?: string } };
    if ('icon' in (a.select ?? {})) {
      const id = a.where?.id ?? '';
      if (isReplica && (opts.replicaLagsOn ?? []).includes(id)) return null;
      return viewByListingId[id] ?? null;
    }
    return owned;
  };
  mockRead.appListing.findUnique.mockImplementation(impl(true));
  mockWrite.appListing.findUnique.mockImplementation(impl(false));
}

/** The listing ids whose `loadListingEditView` read landed on a given pool. */
function editViewReads(client: { appListing: { findUnique: { mock: { calls: unknown[][] } } } }) {
  return client.appListing.findUnique.mock.calls
    .map(([a]) => a as { select?: Record<string, unknown>; where?: { id?: string } })
    .filter((a) => 'icon' in (a?.select ?? {}))
    .map((a) => a.where?.id ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockRead.appListing.findFirst.mockResolvedValue(null);
  // 🔴 EXPLICIT, because `vi.clearAllMocks()` clears CALLS but not IMPLEMENTATIONS — a
  // `mockResolvedValue` set by one case survives into every later case in the file. The
  // hoisted factory's "no seat" default therefore only holds until the first test that
  // wires a seat, and the leak lands on the NEXT non-owner case as a spurious pass.
  mockRead.appCollaborator.findFirst.mockResolvedValue(null);
  mockRead.appListingScreenshot.findMany.mockResolvedValue([]);
  mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
  mockRead.oauthClient.findUnique.mockResolvedValue(null);
  mockWrite.appListing.findFirst.mockResolvedValue(null);
  mockWrite.appListing.update.mockImplementation(async (args: { data: unknown }) => args.data);
  mockWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(mockWrite)
  );
});

describe('getMyListingForEdit', () => {
  it('returns parent scalars + edge-resolved assets for a DRAFT listing (no shadow, no begin)', async () => {
    wireFindUnique(ownedRow({ status: 'draft' }), { apl_parent: editViewRow('ss_parent') });
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });

    expect(res.parentId).toBe('apl_parent');
    expect(res.slug).toBe('vitrine');
    expect(res.status).toBe('draft');
    expect(res.shadowId).toBeNull();
    expect(res.hasPendingRevision).toBe(false);
    expect(res.scalars.name).toBe('Vitrine');
    expect(res.assets.icon).toEqual({ imageId: 10, url: 'edge:icon-key' });
    expect(res.assets.screenshots[0].id).toBe('ss_parent');
    // A draft never touches the revision machinery.
    expect(mockRead.appListing.findFirst).not.toHaveBeenCalled();
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE RETURNED `kind` IS THE LISTING'S REAL KIND.
   *
   * Nothing pinned this, and the omission was not cosmetic: hardcoding
   * `kind: 'offsite'` in `getMyListingForEdit` is type-valid and survived the ENTIRE
   * suite — 15,829 unit tests and 1,476 component tests — while silently making the
   * whole on-site narrowing downstream INERT. `isOnsiteEdit` would answer `false` for
   * every listing, so the edit wizard would go back to offering an on-site app an
   * "App URL" step and an OAuth-scope disclosure, and `buildScalarPatch` would go back
   * to being able to emit `externalUrl` for it. The fix would still be sitting in the
   * diff, and dead.
   *
   * BOTH kinds are pinned, because a hardcode of EITHER literal is the mutant: asserting
   * only the off-site row would survive `kind: 'offsite'`, and asserting only the on-site
   * row would survive `kind: 'onsite'`.
   */
  it("🔴 returns the listing's REAL kind — off-site", async () => {
    wireFindUnique(ownedRow({ status: 'draft', kind: 'offsite' }), {
      apl_parent: editViewRow('ss_parent'),
    });
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.kind).toBe('offsite');
  });

  it("🔴 returns the listing's REAL kind — on-site", async () => {
    wireFindUnique(ownedRow({ status: 'draft', kind: 'onsite' }), {
      apl_parent: editViewRow('ss_parent'),
    });
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.kind).toBe('onsite');
  });

  it('the kind is READ FROM THE ROW, not inferred from any other field', async () => {
    // An on-site row that still carries an `externalUrl` (the shape `mapAppBlockToListing`
    // can mint) must NOT be re-derived as off-site by a well-meaning heuristic.
    wireFindUnique(
      ownedRow({ status: 'draft', kind: 'onsite', externalUrl: 'https://example.com/' }),
      { apl_parent: editViewRow('ss_parent') }
    );
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.kind).toBe('onsite');
  });

  it('returns the connect scope disclosure: CURRENT client allowedScopes (derived set) + STORED snapshot/justifications', async () => {
    wireFindUnique(ownedRow({ status: 'draft', connectClientId: 'oauth-1' }), {
      apl_parent: editViewRow('ss_parent', {
        connectRequestedScopes: 4,
        connectScopeJustifications: { ModelsRead: 'reason' },
      }),
    });
    // The client's allowedScopes drifted to 13 since the stored snapshot (4).
    mockRead.oauthClient.findUnique.mockResolvedValue({ allowedScopes: 13 });

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.connectClientId).toBe('oauth-1');
    expect(res.connectAllowedScopes).toBe(13); // derived = client's CURRENT allowedScopes
    expect(res.connectRequestedScopes).toBe(4); // stored snapshot (drift detectable)
    expect(res.connectScopeJustifications).toEqual({ ModelsRead: 'reason' });
  });

  it('a listing with no connect client → null connect fields, no client lookup', async () => {
    wireFindUnique(ownedRow({ status: 'draft', connectClientId: null }), {
      apl_parent: editViewRow('ss_parent'),
    });
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.connectClientId).toBeNull();
    expect(res.connectAllowedScopes).toBeNull();
    expect(mockRead.oauthClient.findUnique).not.toHaveBeenCalled();
  });

  it('APPROVED with an existing shadow → reuses it; prefill + row ids come from the SHADOW', async () => {
    wireFindUnique(ownedRow({ status: 'approved' }), {
      apl_shadow_existing: editViewRow('ss_shadow', { name: 'Vitrine (edited)' }),
    });
    // beginListingRevision reuses the existing shadow (dbRead.findFirst hit → early return).
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow_existing' });
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue({ id: 'req_pending' });

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.status).toBe('approved');
    expect(res.shadowId).toBe('apl_shadow_existing');
    expect(res.hasPendingRevision).toBe(true);
    expect(res.scalars.name).toBe('Vitrine (edited)');
    // 🔴 the edit-view read targeted the SHADOW, and the screenshot rows are the shadow's.
    // A shadow is read from the PRIMARY even on the reuse path (`created: false`) — it
    // may have been minted microseconds ago by another caller. See the lag test below.
    expect(editViewReads(mockWrite)).toEqual(['apl_shadow_existing']);
    expect(editViewReads(mockRead)).toEqual([]);
    expect(res.assets.screenshots[0].id).toBe('ss_shadow');
    // slug stays the PUBLIC parent slug.
    expect(res.slug).toBe('vitrine');
    // Reuse path never creates a new shadow.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('🔴 APPROVED with NO prior shadow → CREATES one server-side; prefill row ids are the SHADOW copies (never the parent)', async () => {
    wireFindUnique(ownedRow({ status: 'approved' }), {
      apl_shadow_created: editViewRow('ss_shadow_new'),
    });
    // No existing shadow → begin creates. `dbWrite.appListing.findFirst` is used
    // twice: the IN-TX race check (must be null so create runs) then the post-tx
    // winner re-read (returns the created shadow).
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'apl_shadow_created' });
    // The parent has a screenshot to clone onto the shadow (exercises the copy path).
    mockWrite.appListingScreenshot.findMany.mockResolvedValue([
      { imageId: 30, order: 0, caption: 'cap' },
    ]);

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
    expect(res.shadowId).toBe('apl_shadow_created');
    // A shadow was actually created (begin ran its tx create).
    expect(mockWrite.appListing.create).toHaveBeenCalled();
    // 🔴 the returned asset rows are the SHADOW's copies — a removal would target these,
    // never the live parent's row ids.
    expect(editViewReads(mockWrite)).toEqual(['apl_shadow_created']);
    expect(editViewReads(mockRead)).toEqual([]);
    expect(res.assets.screenshots[0].id).toBe('ss_shadow_new');
  });

  /**
   * 🟢 THIS TEST ADDS NO COVERAGE — it is a LABEL on a path this file already exercises,
   * and it is filed here so nobody counts it twice. Say it plainly: `ownedRow` DEFAULTS
   * to `kind: 'offsite'` (see its definition), so the "APPROVED with NO prior shadow →
   * CREATES one" case immediately above ALREADY drives an approved off-site listing
   * through the entire shadow media path, and the "returns the listing's REAL kind —
   * off-site" case already asserts the kind survives. Deleting the `it` below would not
   * move a single line of coverage. It is kept for ONE reason: it names, in one place,
   * the thing those two tests demonstrate incidentally, and it carries the open question.
   *
   * 🟡 CHARACTERIZATION — it pins what the code DOES today. It is not an assertion about
   * what it SHOULD do, and it must not be read as one.
   *
   * `getMyListingForEdit` gates on ownership + status
   * (`loadOwnedEditableListing`, then the shadow / removed / rejected switch) and
   * contains NO `kind` check; neither do the listing-keyed asset procs
   * (`loadOwnedListing`). So an APPROVED OFF-SITE listing goes down the whole
   * shadow-revision media path: a shadow is minted, the prefill returns the
   * SHADOW's asset row ids, and the caller is handed an editable target.
   *
   * Meanwhile `CAPABILITIES_BY_KIND.offsite.listingMedia` is `false`. That cell is
   * read ONLY by the web tab gate (`src/components/Apps/appListingEditorTabs.ts`);
   * no service consults it — unlike `earnings` and `submitVersion`, the two other
   * `false` cells, which ARE enforced service-side.
   *
   * 🔴 OPEN QUESTION, deliberately NOT answered here (raised in the PR for
   * civitai/civitai#3984 for whoever owns the capability table): is off-site media
   * editing through the listing-keyed procs INTENDED — in which case the cell is
   * stale — or a gap the `listingMedia: false` cell believes is closed, in which
   * case the missing check is in the services, not in the tab gate?
   *
   * 🔴 The evidence leans INTENDED, further than the question implies:
   * `REVIEWABLE_LISTING_KINDS = ['onsite','offsite']` (`offsite-listing.service.ts`)
   * means the revision submit → approve → apply chain accepts an off-site listing END TO
   * END, not just the editor entry read. A media revision an off-site owner stages here
   * can be submitted, reviewed and applied. So the `listingMedia: false` cell is a
   * statement about ONE web tab, not about a closed service-side gap. Whichever answer
   * lands, re-label or invert this test; do not silently delete it.
   */
  it('CHARACTERIZATION (already covered above): an APPROVED OFF-SITE listing gets the full shadow media path (no kind check)', async () => {
    wireFindUnique(ownedRow({ kind: 'offsite', status: 'approved' }), {
      apl_shadow_offsite: editViewRow('ss_shadow_offsite'),
    });
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'apl_shadow_offsite' });

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });

    // The listing really is off-site — no kind check refused it anywhere on the path.
    expect(res.kind).toBe('offsite');
    // …and it got everything the on-site media flow gets: a shadow, and the shadow's
    // asset rows (the ids a "remove screenshot" would target).
    expect(mockWrite.appListing.create).toHaveBeenCalled();
    expect(res.shadowId).toBe('apl_shadow_offsite');
    expect(res.assets.screenshots[0].id).toBe('ss_shadow_offsite');
    expect(res.assets.icon).toEqual({ imageId: 10, url: 'edge:icon-key' });
  });

  // -------------------------------------------------------------------------
  // 🔴 READ-AFTER-WRITE (the `getMyListingForEdit` half of the same guard).
  // The shadow is INSERTed on the PRIMARY; reading it back off the replica misses
  // under replication lag → `loadListingEditView` throws NOT_FOUND → tRPC NOT_FOUND
  // → the edit UI's query is `retry: false`, so the whole editor collapses. The
  // routing predicate is "the target is a SHADOW", not "this call created it" —
  // `created: false` only means someone ELSE minted it (the media editor's own
  // client-side `beginListingRevision`, a second tab), which is just as likely to be
  // microseconds old. Both branches are pinned below.
  // -------------------------------------------------------------------------

  it('🔴 a FRESHLY-CREATED shadow the replica lacks still resolves (reads the PRIMARY)', async () => {
    wireFindUnique(
      ownedRow({ status: 'approved' }),
      {
        apl_parent: editViewRow('ss_parent'),
        apl_shadow_created: editViewRow('ss_shadow_new'),
      },
      // INSERTed on the primary this instant — the replica has not received it.
      { replicaLagsOn: ['apl_shadow_created'] }
    );
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'apl_shadow_created' });

    // Routed to the replica this REJECTS with NOT_FOUND instead of resolving.
    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });

    expect(res.shadowId).toBe('apl_shadow_created');
    expect(res.assets.screenshots[0].id).toBe('ss_shadow_new');
    expect(editViewReads(mockWrite)).toEqual(['apl_shadow_created']);
    expect(editViewReads(mockRead)).toEqual([]);
  });

  it('🔴 a REUSED shadow the replica lacks still resolves — `created: false` is not a visibility claim', async () => {
    wireFindUnique(
      ownedRow({ status: 'approved' }),
      {
        apl_parent: editViewRow('ss_parent'),
        apl_shadow_existing: editViewRow('ss_shadow'),
      },
      // A concurrent request minted the shadow microseconds ago; it is on the primary
      // but has not replicated. `beginListingRevision` reports created:FALSE.
      { replicaLagsOn: ['apl_shadow_existing'] }
    );
    // The idempotency probe reads the replica and misses; the in-tx re-check on the
    // primary finds the concurrent winner → no create, created:false.
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow_existing' });

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });

    expect(res.shadowId).toBe('apl_shadow_existing');
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    // The shadow's own rows — never a silent fallback to the live parent's.
    expect(res.assets.screenshots[0].id).toBe('ss_shadow');
    expect(editViewReads(mockWrite)).toEqual(['apl_shadow_existing']);
    expect(editViewReads(mockRead)).toEqual([]);
  });

  it('an IN-PLACE (non-shadow) target stays on the REPLICA — not a blanket primary redirect', async () => {
    wireFindUnique(ownedRow({ status: 'draft' }), { apl_parent: editViewRow('ss_parent') });

    const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });

    expect(res.shadowId).toBeNull();
    // Nothing was written, so nothing needs the primary — the steady-state read load
    // must stay on the replica pool.
    expect(editViewReads(mockRead)).toEqual(['apl_parent']);
    expect(editViewReads(mockWrite)).toEqual([]);
  });

  it('rejects a non-owner (NOT_OWNED)', async () => {
    wireFindUnique(ownedRow({ userId: 999 }), { apl_parent: editViewRow('ss_parent') });
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject(
      {
        code: 'NOT_OWNED',
      }
    );
  });

  it('rejected → MUST_RESUBMIT; removed → FORBIDDEN; a shadow → INVALID_REVISION', async () => {
    wireFindUnique(ownedRow({ status: 'rejected' }), {});
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject(
      {
        code: 'MUST_RESUBMIT',
      }
    );

    wireFindUnique(ownedRow({ status: 'removed' }), {});
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      }
    );

    wireFindUnique(ownedRow({ revisionOfId: 'apl_parent2' }), {});
    await expect(getMyListingForEdit({ listingId: 'apl_parent', userId: 7 })).rejects.toMatchObject(
      {
        code: 'INVALID_REVISION',
      }
    );
  });

  it('throws NOT_FOUND when the listing does not exist', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(null);
    await expect(getMyListingForEdit({ listingId: 'nope', userId: 7 })).rejects.toBeInstanceOf(
      OffsiteRequestError
    );
  });

  /**
   * 🔴 THE RESOLVED ROLE, ASSERTED BY VALUE — the sibling `getMyListingForApp` already has
   * this pair (`offsite-listing.get-my-listing-for-app.service.test.ts`) and this proc did
   * not, which is a real hole rather than a symmetry nit.
   *
   * ~20 cases above call `getMyListingForEdit` and none of them mentions `role`. The
   * explicit `Promise<GetMyListingForEditResult>` annotation catches the field being
   * DROPPED, so the surviving mutation is the one that keeps the field and gets its VALUE
   * wrong: hardcode `role: 'owner'` in place of `listing.callerRole` and the whole unit
   * suite stays green. Downstream that is not cosmetic — `isOwnerEdit` branches the entire
   * repair-state copy on this one string, so a seated editor would be told "you unpublished
   * it" and sent to a Publishing tab `editorTabsFor` withholds from them.
   *
   * The pair is what makes it discriminating. One case on an owner fixture cannot see a
   * hardcoded `'owner'` at all; the editor case is the arm that can, and it is built on a
   * listing owned by SOMEBODY ELSE so the fixture is incapable of producing `'owner'` by
   * accident.
   */
  describe('🔴 the CALLER ROLE is returned by value, not assumed', () => {
    const EDITOR = 42;

    it('returns the OWNER role for the listing owner', async () => {
      wireFindUnique(ownedRow({ status: 'draft' }), { apl_parent: editViewRow('ss_parent') });

      const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: 7 });
      expect(res.role).toBe('owner');
    });

    it('🔴 returns the EDITOR role for an ACCEPTED SEAT — this proc is not owner-only', async () => {
      // 🔴 `userId: 7` stays on the ROW while the CALLER is 42, so the caller cannot be the
      // owner however `resolveCanonicalListingOwner` resolves it (offsite ⇒ the column). A
      // fixture whose caller is also the owner could only ever produce `'owner'` and would
      // be blind to the hardcoding mutant — which is exactly how this survived.
      wireFindUnique(ownedRow({ status: 'draft' }), { apl_parent: editViewRow('ss_parent') });
      mockRead.appCollaborator.findFirst.mockResolvedValue({
        id: 'acol_1',
        appListingId: 'apl_parent',
        userId: EDITOR,
        status: 'accepted',
        role: 'editor',
      });

      const res = await getMyListingForEdit({ listingId: 'apl_parent', userId: EDITOR });
      expect(res.role).toBe('editor');
      // The discriminating control: the two roles must actually DIFFER on this proc, or a
      // mutant that hardcodes `'owner'` passes the case above and nothing here can see it.
      expect(res.role).not.toBe('owner');
    });
  });
});

describe('updateRevisionDraft', () => {
  it('writes the scalar patch to an owned DRAFT shadow', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({ id: 'apl_shadow', status: 'draft', revisionOfId: 'apl_parent' })
    );
    const res = await updateRevisionDraft({
      shadowId: 'apl_shadow',
      userId: 7,
      patch: { name: 'New name', tagline: 'New tagline' },
    });
    expect(res).toEqual({ shadowId: 'apl_shadow' });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apl_shadow' },
        data: expect.objectContaining({ name: 'New name', tagline: 'New tagline' }),
      })
    );
  });

  it('SNAPSHOTS requestedScopes from the client when the shadow patch edits scopes (form value ignored)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({
        id: 'apl_shadow',
        status: 'draft',
        revisionOfId: 'apl_parent',
        connectClientId: 'oauth-1',
      })
    );
    // Client allowedScopes = 13 (UserRead|ModelsRead|ModelsWrite); the form's bogus
    // requestedScopes:4 must be ignored and the derived 13 snapshotted.
    mockRead.oauthClient.findUnique.mockResolvedValue({ userId: 7, allowedScopes: 13 });
    await updateRevisionDraft({
      shadowId: 'apl_shadow',
      userId: 7,
      patch: { requestedScopes: 4, scopeJustifications: { ModelsRead: 'reason' } },
    });
    const data = mockWrite.appListing.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.connectRequestedScopes).toBe(13);
    expect(data.connectScopeJustifications).toEqual({ ModelsRead: 'reason' });
  });

  it('refuses a NON-shadow (top-level listing) → INVALID_REVISION, no write', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({ id: 'apl_parent', status: 'draft', revisionOfId: null })
    );
    await expect(
      updateRevisionDraft({ shadowId: 'apl_parent', userId: 7, patch: { name: 'x' } })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('refuses a non-draft shadow → INVALID_REVISION', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({ id: 'apl_shadow', status: 'approved', revisionOfId: 'apl_parent' })
    );
    await expect(
      updateRevisionDraft({ shadowId: 'apl_shadow', userId: 7, patch: { name: 'x' } })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
  });

  it('refuses a non-owner → NOT_OWNED', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({ id: 'apl_shadow', status: 'draft', revisionOfId: 'apl_parent', userId: 999 })
    );
    await expect(
      updateRevisionDraft({ shadowId: 'apl_shadow', userId: 7, patch: { name: 'x' } })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });

  // #3399 completion: a MOD may edit scopes on a shadow whose linked OAuth client is
  // owned by someone else (the client owner ≠ the listing/shadow owner). The owner
  // re-assertion in deriveScopePatch is bypassed for mods only.
  it('mod scope edit on a shadow linking a FOREIGN client → OK (derived, no FORBIDDEN)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({
        id: 'apl_shadow',
        status: 'draft',
        revisionOfId: 'apl_parent',
        connectClientId: 'oauth-1',
      })
    );
    // Client owned by someone else (999); the shadow/listing is owned by the mod (7).
    mockRead.oauthClient.findUnique.mockResolvedValue({ userId: 999, allowedScopes: 13 });
    await updateRevisionDraft({
      shadowId: 'apl_shadow',
      userId: 7,
      isModerator: true,
      patch: { requestedScopes: 4, scopeJustifications: { ModelsRead: 'reason' } },
    });
    const data = mockWrite.appListing.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.connectRequestedScopes).toBe(13);
  });

  it('non-mod scope edit on a shadow linking a FOREIGN client → FORBIDDEN, no write', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      ownedRow({
        id: 'apl_shadow',
        status: 'draft',
        revisionOfId: 'apl_parent',
        connectClientId: 'oauth-1',
      })
    );
    mockRead.oauthClient.findUnique.mockResolvedValue({ userId: 999, allowedScopes: 13 });
    await expect(
      updateRevisionDraft({
        shadowId: 'apl_shadow',
        userId: 7,
        isModerator: false,
        patch: { requestedScopes: 4, scopeJustifications: { ModelsRead: 'reason' } },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });
});
