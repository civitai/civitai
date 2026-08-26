import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { LISTING_STATUS_CHANGING_MODERATION_ACTIONS } from '~/server/services/blocks/app-listing-owner-unpublish';
import {
  getMyListingForApp,
  getMyListingForEdit,
  listingMediaEditBlockedReason,
  updateListing,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * App Store Listings (W13) — `removed` IS TWO STATES, AND THE EDIT PATHS MUST TELL THEM
 * APART.
 *
 * `app_listings.status = 'removed'` is written by BOTH `unpublishOwnListing` (the owner
 * takes their own app down to fix it up) and a moderator `delist`/`purge`. Every author
 * edit path refused BOTH, and told both callers a MODERATOR had done it — so an owner who
 * unpublished their own listing had no repair step at all, and was misinformed about why.
 *
 * The distinguishing signal is the listing's MOST-RECENT `AppListingModerationEvent`:
 * `owner-unpublish` ⇒ the owner's own action; anything else, or NO event, ⇒ moderator (or
 * unprovable), which stays refused. This is the same predicate `republishOwnListing`'s
 * go-live guard already used, now single-sourced in `app-listing-owner-unpublish`.
 *
 * Both directions are pinned for all three sites, plus the `!lastEvent` arm — that is a
 * real branch, not a degenerate one, and it must FAIL CLOSED.
 *
 * 🔴 RED-AT-BASE, per direction: the `owner-unpublish ⇒ editable` cases and the
 * message-attribution case fail on `origin/main`; the moderator/no-event cases are
 * INVARIANT GUARDS (green on both sides) and are labelled as such below rather than
 * counted as regression coverage.
 *
 * 🔴 SECOND ROUND (the audit fixes). Measured against the pre-fix tip of this branch,
 * `255218262f`, by reverting the four SOURCE files to it and re-running this file:
 *   - REGRESSION coverage (red at `255218262f`, green now): every MATERIAL-field refusal,
 *     the state-neutral-event cases, the collaborator MATERIAL refusal, and the two
 *     query-shape cases.
 *   - MUTATION GUARDS (green on both sides, and NOT regression coverage): the two
 *     "reads the PRIMARY (site 2/3 of 3)" cases. `getMyListingForEdit` and
 *     `getMyListingForApp` already read `dbWrite`; the defect they close is that a
 *     `dbWrite → dbRead` mutation at either site SURVIVED the whole blocks suite, because
 *     only `updateListing` carried a pool assertion. They are labelled as guards here so
 *     nobody counts them as proof of a fixed bug.
 *   - POSITIVE CONTROLS / INVARIANT GUARDS (green on both sides): the trivial-edit cases,
 *     the unchanged-material-key case, the approved-still-stages case, and the
 *     mod-takedown-wins-first case.
 *
 * DB fully mocked — no real Prisma.
 */

type Row = Record<string, unknown> & { id: string };

/**
 * 🔴 THE CANONICAL `~/server/db/client` MOCK, not a per-file `vi.mock`. Registered once in
 * `src/__tests__/setup.ts`; a hand-rolled one here would freeze this file's mock shape into
 * every later file in the same worker under `isolate: false`. See
 * docs/testing/shared-module-mocks.md and `no-direct-shared-module-mock.test.ts`.
 *
 * `dbRead` and `dbWrite` are DISTINCT nodes here, which is what makes the "the gate reads
 * the PRIMARY" case below able to say anything at all.
 */
const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

const OWNER = 42;
const LISTING_ID = 'apl_parent';

/** The one message a MODERATOR takedown is allowed to produce. Pinned as a literal. */
const MOD_TAKEDOWN_MESSAGE =
  'this listing has been removed by a moderator and can no longer be edited';

/**
 * An owner-owned OFF-SITE listing row, as `editableListingSelect` returns it (plus
 * `sourceRepoUrl`, which the service reads through its own guarded second query on the
 * same `findUnique` fake).
 *
 * 🔴 EVERY MATERIAL FIELD CARRIES A DISTINCT, NON-DEFAULT VALUE, and none of them equals
 * a value any assertion below names as the "changed" one. An all-defaults fixture (empty
 * strings, `null` externalUrl, `contentRating: 'g'`) collapses "the patch changed X" and
 * "the patch left X alone" into the same observable, so a mutant that compares the wrong
 * field — or that hardcodes a constant — survives. `contentRating` is `'r'` specifically
 * so the LOWERING case (`r → g`) can be exercised in the direction that matters.
 */
function listingRow(overrides: Partial<Row> = {}): Row {
  return {
    id: LISTING_ID,
    kind: 'offsite',
    slug: 'cool-app',
    status: 'removed',
    userId: OWNER,
    revisionOfId: null,
    name: 'Cool App',
    tagline: 'the tagline',
    description: 'the description',
    category: 'utility',
    contentRating: 'r',
    externalUrl: 'https://cool.example.com/app',
    sourceRepoUrl: 'https://github.com/cool/app',
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 1,
    coverId: 2,
    ...overrides,
  };
}

/** The `loadListingEditView` projection (the `select` carrying `icon`). */
function editViewRow(): Record<string, unknown> {
  return {
    name: 'Cool App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    externalUrl: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 1,
    coverId: 2,
    icon: { url: 'icon-key' },
    cover: { url: 'cover-key' },
    screenshots: [],
  };
}

/**
 * Serve `row` on every `appListing.findUnique` shape the edit paths use — the entry
 * resolve (`where.appBlockId`), the edit-view projection (`select` carries `icon`), and
 * the owned/editable + ownership + source-repo reads (everything else).
 */
function wireListing(row: Row) {
  const impl = async (args: unknown) => {
    const a = args as { select?: Record<string, unknown> };
    if ('icon' in (a.select ?? {})) return editViewRow();
    return row;
  };
  mockRead.appListing.findUnique.mockImplementation(impl);
  mockWrite.appListing.findUnique.mockImplementation(impl);
  // `getMyListingForApp`'s SLUG arm resolves through `findFirst` on the replica.
  mockRead.appListing.findFirst.mockImplementation(async (args: unknown) => {
    const a = args as { where?: { slug?: string } };
    return a.where?.slug === row.slug ? row : null;
  });
}

/**
 * Wire the listing's last moderation event on BOTH pools.
 *
 * Both, deliberately: a case that wired only the primary would pass even if the code read
 * the replica, and vice versa — so no behavioural case here is secretly a pool assertion.
 * WHICH pool the gates use is asserted on its own, by the "reads the last event from the
 * PRIMARY" case below.
 */
function wireLastModerationEvent(action: string | null) {
  const value = action == null ? null : { action };
  mockRead.appListingModerationEvent.findFirst.mockResolvedValue(value);
  mockWrite.appListingModerationEvent.findFirst.mockResolvedValue(value);
}

beforeEach(() => {
  // 🔴 The canonical mock resets between FILES, not between tests — several cases here
  // assert `not.toHaveBeenCalled()`, which silently reads a previous test's calls without
  // this. Implementations survive `mockClear`, so the defaults below are re-declared after.
  vi.clearAllMocks();
  // The canonical mock resets every node between files; these are this file's DEFAULTS.
  for (const client of [mockRead, mockWrite]) {
    client.appListing.findUnique.mockResolvedValue(null);
    client.appListing.findFirst.mockResolvedValue(null);
    client.appListing.create.mockImplementation(async (a: { data: unknown }) => a.data);
    client.appListing.update.mockImplementation(async (a: { data: unknown }) => a.data);
    client.appCollaborator.findFirst.mockResolvedValue(null);
    client.appListingScreenshot.findMany.mockResolvedValue([]);
    client.appListingPublishRequest.findFirst.mockResolvedValue(null);
    client.appListingModerationEvent.findFirst.mockResolvedValue(null);
    client.image.findMany.mockResolvedValue([]);
  }
  mockWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(mockWrite)
  );
});

// ---------------------------------------------------------------------------
// updateListing — the WRITE path
// ---------------------------------------------------------------------------

describe('updateListing on a `removed` listing', () => {
  it('🔴 OWNER-UNPUBLISH ⇒ EDITABLE: the scalar patch is written IN PLACE, no re-review', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await updateListing({
      listingId: LISTING_ID,
      patch: { tagline: 'fixing this up' },
      userId: OWNER,
    });

    expect(res).toEqual({
      listingId: LISTING_ID,
      status: 'removed',
      requiresReview: false,
      shadowId: null,
    });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      data: { tagline: 'fixing this up' },
    });
    // In place, exactly like draft/pending — a listing that is not being served has no
    // live copy to protect behind a shadow revision.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (green at base too): a MODERATOR delist stays FORBIDDEN, and keeps blaming a moderator', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('delist');

    await expect(
      updateListing({ listingId: LISTING_ID, patch: { tagline: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (green at base too): a `purge` is likewise not owner-unpublish → FORBIDDEN', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('purge');

    await expect(
      updateListing({ listingId: LISTING_ID, patch: { tagline: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (green at base too): NO moderation events at all → FORBIDDEN (fails CLOSED)', async () => {
    // 🔴 `!lastEvent` is a real branch. Nothing proves the owner took this listing down,
    // so it must be treated as a moderator removal — never trusted to the owner.
    wireListing(listingRow());
    wireLastModerationEvent(null);

    await expect(
      updateListing({ listingId: LISTING_ID, patch: { tagline: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('🔴 reads the last event from the PRIMARY, newest-first with the id tiebreak', async () => {
    // Pool: a stale replica can hide a moderator's just-written `delist` behind the
    // owner's older `owner-unpublish` and GRANT an edit that was revoked. Ordering:
    // `createdAt` alone is not a total order (same-tx events share a timestamp), so the
    // id tiebreak is what makes "most recent" deterministic.
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    await updateListing({ listingId: LISTING_ID, patch: { tagline: 'y' }, userId: OWNER });

    expect(mockWrite.appListingModerationEvent.findFirst).toHaveBeenCalledWith({
      where: {
        appListingId: LISTING_ID,
        action: { in: [...LISTING_STATUS_CHANGING_MODERATION_ACTIONS] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true },
    });
    expect(mockRead.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
  });

  it('does NOT read moderation events for a non-`removed` listing (no extra round trip)', async () => {
    wireListing(listingRow({ status: 'draft' }));

    await updateListing({ listingId: LISTING_ID, patch: { tagline: 'z' }, userId: OWNER });

    expect(mockWrite.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
    expect(mockRead.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateListing — MATERIAL fields on the newly-opened `removed` path
// ---------------------------------------------------------------------------

/**
 * 🔴 THE EXPLOIT THIS BLOCK PINS SHUT, spelled out so nobody re-opens it by "simplifying"
 * the branch. `removed` + `owner-unpublish` is the state an owner can put their OWN listing
 * into and take it back out of, with NO moderator in the loop:
 *
 *     approved → unpublishOwnListing → updateListing(<material>) → republishOwnListing → approved
 *
 * `republishOwnListing` gates on `assertListingAssetsScanCleanInTx` (did the images finish
 * scanning?) and `assertOffsiteListingActionableInTx` (is there an https href at all?).
 * NEITHER is a content review, so without a material-field refusal the store's destination
 * URL, its displayed name, its public repo link, its disclosed OAuth scopes and its content
 * rating could all be swapped AFTER approval. The refusal below is the whole guarantee; the
 * republish path contributes nothing to it.
 *
 * Reachable today via the `appListings.updateListing` tRPC mutation and by CLI token under
 * `TokenScope.AppBlocksSubmit` — "there is no UI button" is not a mitigation.
 *
 * 🔴 RED AT BASE: every case here fails on the pre-fix tip of this branch
 * (`255218262f`), where the arm wrote the FULL patch in place and returned
 * `requiresReview:false`. They are regression coverage, not invariant guards.
 */
describe('updateListing on an OWNER-UNPUBLISHED listing — MATERIAL fields are REFUSED', () => {
  /** The typed code the refusal must carry (the router maps it to BAD_REQUEST). */
  const BLOCKED = 'MATERIAL_CHANGE_BLOCKED';

  async function expectRefused(patch: Record<string, unknown>, field: string) {
    wireLastModerationEvent('owner-unpublish');
    const err = await updateListing({
      listingId: LISTING_ID,
      patch: patch as never,
      userId: OWNER,
    }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string }
    );

    // Not merely "it threw" — the RIGHT refusal, naming the RIGHT field.
    expect(err?.code).toBe(BLOCKED);
    expect(err?.message).toContain(field);
    // 🔴 AND NOTHING WAS WRITTEN, on either the parent or a shadow. A refusal that still
    // persisted the row would be the same defect with an error message stapled on.
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    return err;
  }

  it('🔴 externalUrl — the STORE DESTINATION cannot be swapped after approval', async () => {
    wireListing(listingRow());
    await expectRefused({ externalUrl: 'https://evil.example.com/app' }, 'externalUrl');
  });

  it('🔴 name — the listing IDENTITY cannot be swapped after approval', async () => {
    wireListing(listingRow());
    await expectRefused({ name: 'Totally Different App' }, 'name');
  });

  it('🔴 contentRating LOWERED r → g — Finding 1 subsumes the SFW-filter half', async () => {
    // `contentRating` drives the public SFW filter (`content_rating NOT IN ('r','x')`) and
    // `republishOwnListing` runs NO rating floor (`resolveListingRatingFloorInTx` is wired
    // into the approve paths only), so lowering it in place would surface a still-mature
    // listing to SFW users with nothing else in the chain to catch it. It is refused here
    // because it is MATERIAL — the same one rule, not a second special case.
    wireListing(listingRow({ contentRating: 'r' }));
    await expectRefused({ contentRating: 'g' }, 'contentRating');
  });

  it('contentRating RAISED g → r is refused too — the rule is "material", not "lowered"', async () => {
    // Direction-independent on purpose: a rating change is a moderator-visible fact either
    // way, and a rule that only caught the "dangerous" direction would be a rule about the
    // exploit rather than about review.
    wireListing(listingRow({ contentRating: 'g' }));
    await expectRefused({ contentRating: 'r' }, 'contentRating');
  });

  it('🔴 sourceRepoUrl — the public OUTBOUND repo link is material for the same reason', async () => {
    wireListing(listingRow());
    await expectRefused(
      { sourceRepoUrl: 'https://github.com/someone-else/other' },
      'sourceRepoUrl'
    );
  });

  it('🔴 requestedScopes — a DISCLOSED OAuth scope drift cannot go live unreviewed', async () => {
    // The mask is SERVER-DERIVED from the client's current `allowedScopes`, so the drift
    // that matters is client-ceiling vs stored snapshot, not what the form sent.
    wireListing(listingRow({ connectClientId: 'oc_1', connectRequestedScopes: 1 }));
    mockRead.oauthClient.findUnique.mockResolvedValue({ userId: OWNER, allowedScopes: 7 });

    await expectRefused({ requestedScopes: 1, scopeJustifications: {} }, 'requestedScopes');
  });

  it('names EVERY offending field, not just the first', async () => {
    wireListing(listingRow());
    const err = await expectRefused(
      { name: 'Other', externalUrl: 'https://evil.example.com/app', tagline: 'ok' },
      'name'
    );
    expect(err?.message).toContain('externalUrl');
    // The trivial key travelling alongside is not accused.
    expect(err?.message).not.toContain('tagline: ');
  });

  it('🔴 POSITIVE CONTROL — the FEATURE still works: tagline/description/category edit in place', async () => {
    // This is the user need the whole PR exists for ("unpublish → fix your copy →
    // republish"). If the refusal above were over-broad it would land here, and this case
    // is what would say so.
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await updateListing({
      listingId: LISTING_ID,
      patch: { tagline: 'clearer tagline', description: 'clearer copy', category: 'discovery' },
      userId: OWNER,
    });

    expect(res).toEqual({
      listingId: LISTING_ID,
      status: 'removed',
      requiresReview: false,
      shadowId: null,
    });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      data: { tagline: 'clearer tagline', description: 'clearer copy', category: 'discovery' },
    });
  });

  /**
   * 🔴 THIS IS ALSO THE ONLY CASE THAT CAN SEE A WRONG `live` BIND, and it took a surviving
   * mutant to notice. Every "changed ⇒ refused" case above compares a patched value against
   * a DIFFERENT live value, so replacing a `live.<field>` with a constant (`null`) leaves
   * the inequality true and the refusal identical — the mutant `contentRating:
   * listing.contentRating → contentRating: null` SURVIVED the whole battery on those cases
   * alone. Only an UNCHANGED value distinguishes them: correct code sees equality and
   * saves, a wrong bind sees `'r' !== null` and refuses. So every material field is
   * re-sent VERBATIM here, not just one.
   */
  it('a material key present but UNCHANGED is not a change — every material field, verbatim', async () => {
    // The editor round-trips every field, so a re-save of an untouched form carries them
    // all. Refusing on PRESENCE rather than on CHANGE would make the repair loop unusable
    // from the actual UI while looking correct in a unit test that only ever sends deltas.
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await updateListing({
      listingId: LISTING_ID,
      patch: {
        name: 'Cool App',
        contentRating: 'r',
        externalUrl: 'https://cool.example.com/app',
        sourceRepoUrl: 'https://github.com/cool/app',
        tagline: 'still fixing',
      },
      userId: OWNER,
    });

    expect(res.requiresReview).toBe(false);
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      data: {
        name: 'Cool App',
        contentRating: 'r',
        externalUrl: 'https://cool.example.com/app',
        sourceRepoUrl: 'https://github.com/cool/app',
        tagline: 'still fixing',
      },
    });
  });

  it('🔴 the refusal is scoped to `removed` — an APPROVED listing still STAGES a material change', async () => {
    // Negative control on the branch itself: if the refusal leaked into the approved arm
    // it would break the shadow-revision flow, and every case above would still pass.
    wireListing(listingRow({ status: 'approved' }));
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' });

    const res = await updateListing({
      listingId: LISTING_ID,
      patch: { name: 'Renamed' },
      userId: OWNER,
    });

    expect(res).toMatchObject({ requiresReview: true, shadowId: 'apl_shadow' });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_shadow' },
      data: { name: 'Renamed' },
    });
  });

  it('a MODERATOR takedown is refused BEFORE the material check — attribution wins', async () => {
    // Ordering matters for the message the caller sees: on a mod takedown they must be
    // told the listing is moderator-removed, not that `externalUrl` needs a republish
    // they are not allowed to perform.
    wireListing(listingRow());
    wireLastModerationEvent('delist');

    await expect(
      updateListing({
        listingId: LISTING_ID,
        patch: { externalUrl: 'https://evil.example.com/app' },
        userId: OWNER,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// The repair loop survives a moderator MESSAGE (state-neutral events)
// ---------------------------------------------------------------------------

/**
 * 🔴 A moderator messaging the owner *"fix X and republish"* is the most natural workflow
 * this feature has, and it writes an `AppListingModerationEvent` — `action:'message-owner'`
 * — that changes no listing status. An unfiltered "last event of any kind" read therefore
 * REVOKED the repair loop and re-showed the owner the false "removed by a moderator"
 * attribution the PR exists to delete. Same class as `report-resolve`/`report-dismiss`
 * (`closeReport` writes those ungated) and `claim`.
 *
 * These cases are behavioural: they wire the DB fake to answer the FILTERED query the way
 * the database would, so a code path that dropped the filter reads the neutral row instead.
 */
describe('a STATE-NEUTRAL moderation event does not revoke the repair loop', () => {
  /**
   * Answer like the real table: the newest row overall is state-neutral, but the newest
   * STATUS-CHANGING row is the owner's own unpublish. Which one comes back depends
   * entirely on whether the caller filtered.
   */
  function wireNeutralOnTopOfOwnerUnpublish(neutral: string) {
    const impl = async (args: unknown) => {
      const a = args as { where?: { action?: { in?: string[] } } };
      const allowed = a.where?.action?.in;
      if (!allowed) return { action: neutral }; // unfiltered ⇒ the neutral row wins
      return allowed.includes('owner-unpublish') ? { action: 'owner-unpublish' } : null;
    };
    mockRead.appListingModerationEvent.findFirst.mockImplementation(impl);
    mockWrite.appListingModerationEvent.findFirst.mockImplementation(impl);
  }

  it.each(['message-owner', 'report-resolve', 'report-dismiss', 'claim'])(
    '🔴 %s on top of an owner-unpublish ⇒ updateListing still edits in place',
    async (neutral) => {
      wireListing(listingRow());
      wireNeutralOnTopOfOwnerUnpublish(neutral);

      const res = await updateListing({
        listingId: LISTING_ID,
        patch: { tagline: 'as the mod asked' },
        userId: OWNER,
      });

      expect(res.status).toBe('removed');
      expect(mockWrite.appListing.update).toHaveBeenCalledWith({
        where: { id: LISTING_ID },
        data: { tagline: 'as the mod asked' },
      });
    }
  );

  it('🔴 message-owner on top of an owner-unpublish ⇒ the media editor is not blocked', async () => {
    wireListing(listingRow());
    wireNeutralOnTopOfOwnerUnpublish('message-owner');

    const res = await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(res.editBlockedReason).toBeNull();
  });

  it('🔴 message-owner on top of an owner-unpublish ⇒ the prefill read resolves', async () => {
    wireListing(listingRow());
    wireNeutralOnTopOfOwnerUnpublish('message-owner');

    await expect(
      getMyListingForEdit({ listingId: LISTING_ID, userId: OWNER })
    ).resolves.toMatchObject({ status: 'removed' });
  });

  it('INVARIANT GUARD: a state-neutral event on top of a DELIST is still a delist', async () => {
    // The filter must not become a way to walk past a moderator takedown by getting a
    // report closed afterwards — the direction `closeTerminalListing` was already bitten in.
    const impl = async (args: unknown) => {
      const a = args as { where?: { action?: { in?: string[] } } };
      const allowed = a.where?.action?.in;
      if (!allowed) return { action: 'report-resolve' };
      return allowed.includes('delist') ? { action: 'delist' } : null;
    };
    mockRead.appListingModerationEvent.findFirst.mockImplementation(impl);
    mockWrite.appListingModerationEvent.findFirst.mockImplementation(impl);
    wireListing(listingRow());

    await expect(
      updateListing({ listingId: LISTING_ID, patch: { tagline: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// Finding 7 — the grant reaches an accepted COLLABORATOR, deliberately
// ---------------------------------------------------------------------------

/**
 * 🔴 STATED AND PINNED RATHER THAN LEFT IMPLICIT. `updateListing` gates through
 * `resolveListingRole`, which admits the OWNER **or an accepted seat**, while
 * `readLastModerationAction` selects only `action` — never `actorUserId`. So the predicate
 * asks "is this listing in owner-repair state?" and the gate asks "may THIS caller edit
 * it?", and they are different questions on purpose.
 *
 * The decision: KEEP the seat's reach. A collaborator already has exactly this power on
 * draft/pending/approved, so refusing only in the repair state would make the one flow most
 * likely to need help the one flow a team cannot share; the seat is an authorization the
 * owner granted and can revoke; and with material fields refused, everything reachable is
 * copy. The asymmetry that stays: `unpublishOwnListing`/`republishOwnListing` are
 * OWNER-ONLY (`loadOwnedListingInTx` compares `listing.userId`), so a collaborator can
 * repair the copy but can neither take the app down nor put it back.
 */
describe('an accepted COLLABORATOR on an owner-unpublished listing', () => {
  const EDITOR = 99;

  /** `resolveListingAccess` reads an accepted seat off `appCollaborator`. */
  function wireAcceptedSeat() {
    mockRead.appCollaborator.findFirst.mockResolvedValue({
      id: 'ac_1',
      userId: EDITOR,
      appListingId: LISTING_ID,
      status: 'accepted',
      role: 'editor',
    });
  }

  it('MAY make a TRIVIAL edit — the repair loop is shareable with the team', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');
    wireAcceptedSeat();

    const res = await updateListing({
      listingId: LISTING_ID,
      patch: { tagline: 'seat-holder copy fix' },
      userId: EDITOR,
    });

    expect(res.status).toBe('removed');
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      data: { tagline: 'seat-holder copy fix' },
    });
  });

  it('🔴 MAY NOT change a MATERIAL field — the refusal is not owner-specific', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');
    wireAcceptedSeat();

    await expect(
      updateListing({
        listingId: LISTING_ID,
        patch: { externalUrl: 'https://evil.example.com/app' },
        userId: EDITOR,
      })
    ).rejects.toMatchObject({ code: 'MATERIAL_CHANGE_BLOCKED' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD: a stranger with no seat is still NOT_OWNED', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');
    mockRead.appCollaborator.findFirst.mockResolvedValue(null);

    await expect(
      updateListing({ listingId: LISTING_ID, patch: { tagline: 'x' }, userId: 1234 })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });
});

// ---------------------------------------------------------------------------
// getMyListingForEdit — the PREFILL read
// ---------------------------------------------------------------------------

describe('getMyListingForEdit on a `removed` listing', () => {
  it('🔴 OWNER-UNPUBLISH ⇒ EDITABLE: the prefill resolves instead of throwing FORBIDDEN', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await getMyListingForEdit({ listingId: LISTING_ID, userId: OWNER });

    expect(res).toMatchObject({ parentId: LISTING_ID, status: 'removed', shadowId: null });
    // Not approved ⇒ edited in place, so no shadow revision is minted on the prefill.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (green at base too): a MODERATOR delist stays FORBIDDEN with the moderator message', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('delist');

    await expect(
      getMyListingForEdit({ listingId: LISTING_ID, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
  });

  it('INVARIANT GUARD (green at base too): NO moderation events → FORBIDDEN (fails CLOSED)', async () => {
    wireListing(listingRow());
    wireLastModerationEvent(null);

    await expect(
      getMyListingForEdit({ listingId: LISTING_ID, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
  });

  it('🔴 reads the last event from the PRIMARY (site 2 of 3)', async () => {
    // Same safety argument as `updateListing`, pinned SEPARATELY because it is a
    // separate call: a `dbWrite → dbRead` mutation at this site SURVIVED the whole blocks
    // suite while only `updateListing` carried a pool assertion. A stale replica can hide
    // a moderator's just-written `delist` behind the owner's older `owner-unpublish`, and
    // the direction that costs is the GRANT — this read is what mounts the editor.
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    await getMyListingForEdit({ listingId: LISTING_ID, userId: OWNER });

    expect(mockWrite.appListingModerationEvent.findFirst).toHaveBeenCalled();
    expect(mockRead.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getMyListingForApp → editBlockedReason — the MEDIA-EDITOR verdict
// ---------------------------------------------------------------------------

describe('getMyListingForApp editBlockedReason on a `removed` listing', () => {
  /**
   * 🔴 ONE CASE, NOT TWO. This used to be split into "the verdict is null" and "the verdict
   * never says 'by a moderator'", and the second could not fail unless the first did:
   * identical fixture, identical call, and `null` satisfies both a `not.toContain` and a
   * `not.toBe(MOD_TAKEDOWN_MESSAGE)` trivially. Two tests that die together are one test
   * that reads as two — they inflate the count without adding a way for the code to be
   * wrong. `toBeNull()` is the strictly stronger assertion, so it is the one kept.
   */
  it('🔴 OWNER-UNPUBLISH ⇒ the media editor is NOT blocked, so nothing blames a moderator', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(res.status).toBe('removed');
    // Null is the whole claim: no verdict at all ⇒ no attribution, correct or otherwise.
    // The mod-takedown case below is the arm that pins the message text.
    expect(res.editBlockedReason).toBeNull();
  });

  it('INVARIANT GUARD (green at base too): a MODERATOR delist still returns the moderator verdict', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('delist');

    const res = await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(res.editBlockedReason).toBe(MOD_TAKEDOWN_MESSAGE);
  });

  it('INVARIANT GUARD (green at base too): NO moderation events → the moderator verdict (fails CLOSED)', async () => {
    wireListing(listingRow());
    wireLastModerationEvent(null);

    const res = await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(res.editBlockedReason).toBe(MOD_TAKEDOWN_MESSAGE);
  });

  it('🔴 reads the last event from the PRIMARY (site 3 of 3)', async () => {
    // The third of the three sites, pinned for the same reason as the other two — a
    // `dbWrite → dbRead` mutation here also SURVIVED the full blocks suite. This verdict
    // is what unblocks the MEDIA editor, so a stale-read GRANT hands asset writes to
    // someone a moderator has just cut off.
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(mockWrite.appListingModerationEvent.findFirst).toHaveBeenCalled();
    expect(mockRead.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listingMediaEditBlockedReason — the PURE branch table
// ---------------------------------------------------------------------------

describe('listingMediaEditBlockedReason (pure, synchronous)', () => {
  const removed = { status: 'removed', revisionOfId: null };

  it('🔴 removed + ownerUnpublished=true ⇒ null (editable)', () => {
    expect(listingMediaEditBlockedReason(removed, true)).toBeNull();
  });

  it('INVARIANT GUARD (green at base too): removed + ownerUnpublished=false ⇒ the moderator message', () => {
    expect(listingMediaEditBlockedReason(removed, false)).toBe(MOD_TAKEDOWN_MESSAGE);
  });

  it('INVARIANT GUARD: `ownerUnpublished` is consulted ONLY on `removed`', () => {
    // A shadow, a rejected listing and an unknown status keep their verdicts whatever
    // the owner-unpublish bit says — otherwise this parameter would be a way to walk
    // past three other refusals.
    for (const ownerUnpublished of [true, false]) {
      expect(
        listingMediaEditBlockedReason(
          { status: 'approved', revisionOfId: 'apl_p' },
          ownerUnpublished
        )
      ).toBe('this listing is an internal revision draft and cannot be edited directly');
      expect(
        listingMediaEditBlockedReason({ status: 'rejected', revisionOfId: null }, ownerUnpublished)
      ).toBe('this listing was rejected; submit a new listing instead of editing it');
      expect(
        listingMediaEditBlockedReason({ status: 'banana', revisionOfId: null }, ownerUnpublished)
      ).toBe('cannot edit a listing in status banana');
      expect(
        listingMediaEditBlockedReason({ status: 'approved', revisionOfId: null }, ownerUnpublished)
      ).toBeNull();
    }
  });
});
