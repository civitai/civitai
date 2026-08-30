import { describe, expect, it } from 'vitest';

import {
  actionOpensOwnerMessage,
  actionRequiresReason,
  ALL_LISTING_MOD_ACTIONS,
  effectiveModerationStatus,
  isDestructiveListingModAction,
  listingKindChip,
  listingModActionLabel,
  listingModActions,
  listingModActionsForRow,
  type ListingModAction,
} from '~/components/Apps/appListingModerationTableView';

const pendingReq = {
  id: 'alpr_1',
  submittedAt: new Date('2026-07-24T00:00:00Z'),
  changelog: null,
  submittedBy: null,
};

/**
 * W13 post-approval mgmt (P2) — the mod management-table action view model. The
 * blocking correctness gate for the KIND-AWARE per-row action set (the browser
 * suite is report-only). Pins: which actions each status offers, and that the
 * off-site-only actions (claim / purge / review) NEVER appear on an on-site row
 * while the dual-kind ones (reset-to-pending / hide / relist) do.
 */

describe('listingModActions — off-site rows', () => {
  it('pending (with a pending request) → Review + Message owner', () => {
    expect(
      listingModActions({
        status: 'pending',
        kind: 'offsite',
        hasPendingRequest: true,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['review', 'message-owner']);
  });

  it('approved → Reset to pending + Hide', () => {
    expect(
      listingModActions({
        status: 'approved',
        kind: 'offsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['message-owner', 'reset-to-pending', 'hide']);
  });

  it('removed → Relist + Claim + Purge', () => {
    expect(
      listingModActions({
        status: 'removed',
        kind: 'offsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['message-owner', 'relist', 'claim', 'purge']);
  });

  it('draft → no lifecycle action (unless a pending request offers Review)', () => {
    expect(
      listingModActions({
        status: 'draft',
        kind: 'offsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['message-owner']);
    expect(
      listingModActions({
        status: 'draft',
        kind: 'offsite',
        hasPendingRequest: true,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['review', 'message-owner']);
  });

  it('rejected → read-only apart from Message owner', () => {
    expect(
      listingModActions({
        status: 'rejected',
        kind: 'offsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['message-owner']);
  });
});

describe('listingModActions — on-site rows hide the off-site-only actions', () => {
  it('approved on-site → Reset to pending + Hide (reset is now dual-kind, #3165)', () => {
    expect(
      listingModActions({
        status: 'approved',
        kind: 'onsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: 'ablk_live',
      })
    ).toEqual(['message-owner', 'reset-to-pending', 'hide']);
  });

  it('removed on-site → Relist ONLY (no claim / purge)', () => {
    expect(
      listingModActions({
        status: 'removed',
        kind: 'onsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: 'ablk_live',
      })
    ).toEqual(['message-owner', 'relist']);
  });

  it('pending on-site → NO Review (approve/reject is off-site only; onsite uses its own queue)', () => {
    expect(
      listingModActions({
        status: 'pending',
        kind: 'onsite',
        hasPendingRequest: true,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['message-owner']);
  });
});

/**
 * 🔴 THE ON-SITE ORPHAN PRE-APPROVAL DRAFT — the one on-site shape that DOES offer Purge, and
 * the reason this branch exists at all (clawgate #302).
 *
 * `rejectRequest` no longer deletes the pre-approval draft, so a rejected-and-abandoned first
 * submission sits in this table holding its slug forever. `delistListing` is status-guarded to
 * `{approved, removed}` and cannot touch a `draft`, so Purge here is the ONLY way a moderator
 * can reclaim that slug. A row offering nothing but "message owner" is the state the
 * reject-time delete used to prevent — the service arm existing is not enough if the operator
 * cannot reach it.
 *
 * The three refusals below are one-term-off from the purgeable shape, so each pins its own term.
 */
describe('listingModActions — on-site orphan pre-approval draft offers Purge', () => {
  it('draft + never approved + no pending request → Purge', () => {
    expect(
      listingModActions({
        status: 'draft',
        kind: 'onsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['message-owner', 'purge']);
  });

  /**
   * 🔴 THE TERM THAT WAS INERT. `hasPendingRequest` comes from the
   * `AppListingPublishRequest` relation, whose `appListingId` is "On-site: NULL until
   * approve" — so for an on-site pre-approval draft it is ALWAYS false, and an earlier
   * revision of this branch gated on it. That guard could never fire, and the mod table
   * offered Purge on submissions under active review. The real signal is
   * `hasPendingBlockRequest`, hydrated by a slug-keyed lookup against
   * `AppBlockPublishRequest`.
   *
   * The two cases below are the proof: gating on the WRONG field would let case 1 through.
   */
  it('NOT while the BLOCK request is still pending — that submission is under review', () => {
    expect(
      listingModActions({
        status: 'draft',
        kind: 'onsite',
        // The inert field says "nothing pending"…
        hasPendingRequest: false,
        // …while the real one says otherwise. Purge must be withheld.
        hasPendingBlockRequest: true,
        appBlockId: null,
      })
    ).toEqual(['message-owner']);
  });

  it('`hasPendingRequest` alone does NOT withhold purge — it is the wrong table', () => {
    // Not an endorsement of the state (it is unreachable for this shape); it pins that the
    // branch keys on `hasPendingBlockRequest` and nothing else, so a future edit that swaps
    // the fields back is a red test rather than a silent regression.
    expect(
      listingModActions({
        status: 'draft',
        kind: 'onsite',
        hasPendingRequest: true,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['message-owner', 'purge']);
  });

  it('NOT once it has a backing AppBlock — it reached approve', () => {
    expect(
      listingModActions({
        status: 'draft',
        kind: 'onsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: 'ablk_live',
      })
    ).toEqual(['message-owner']);
  });

  it('NOT for an off-site draft — that arm is unchanged and gated on `removed`', () => {
    expect(
      listingModActions({
        status: 'draft',
        kind: 'offsite',
        hasPendingRequest: false,
        hasPendingBlockRequest: false,
        appBlockId: null,
      })
    ).toEqual(['message-owner']);
  });

  it('Purge stays the confirm-gated destructive action', () => {
    expect(isDestructiveListingModAction('purge')).toBe(true);
  });
});

/**
 * 🔴 `message-owner` IS THE ONE UNCONDITIONAL ACTION, and this block is the guard on
 * that claim rather than a restatement of the cases above.
 *
 * The proc it fronts (`appListings.messageAppOwner`) resolves its recipient through
 * `resolveListingAccess`, which branches on KIND and never on STATUS — so there is no
 * row in this table on which the button would 4xx. The whole reason the feature was
 * unreachable for its first release is that no surface offered it; a narrowing that
 * silently drops it from (say) rejected rows re-creates that, and it is exactly the
 * kind of regression the per-status cases above would NOT catch, because each of them
 * only pins the status it names.
 *
 * The cross product is enumerated, not sampled.
 */
describe('listingModActions — the owner-message action is offered on EVERY row', () => {
  const STATUSES = ['draft', 'pending', 'approved', 'rejected', 'removed'] as const;
  const KINDS = ['onsite', 'offsite'] as const;

  it('appears for every status × kind × pending-request × block-request × backing-block combination', () => {
    const missing: string[] = [];
    let walked = 0;
    for (const status of STATUSES) {
      for (const kind of KINDS) {
        for (const hasPendingRequest of [true, false]) {
          // `appBlockId` joined the input for the orphan-draft Purge branch, so it is now
          // part of the cross product too — otherwise the sweep would pin only one of the
          // two shapes the new branch distinguishes.
          for (const appBlockId of [null, 'ablk_live']) {
            for (const hasPendingBlockRequest of [true, false]) {
              walked++;
              const actions = listingModActions({
                status,
                kind,
                hasPendingRequest,
                hasPendingBlockRequest,
                appBlockId,
              });
              if (!actions.includes('message-owner')) {
                missing.push(
                  `${kind}/${status}/pending=${hasPendingRequest}/blockReq=${hasPendingBlockRequest}/block=${appBlockId}`
                );
              }
            }
          }
        }
      }
    }
    // Positive control on the enumeration itself: 5 statuses × 2 kinds × 2 × 2 × 2 = 80 cases
    // were actually walked, so an empty `missing` is a real sweep and not an empty loop.
    expect(walked).toBe(80);
    expect(STATUSES.length * KINDS.length * 2 * 2 * 2).toBe(80);
    expect(missing).toEqual([]);
  });

  it('is never the LAST action when a destructive one is present (purge stays rightmost)', () => {
    const removed = listingModActions({
      status: 'removed',
      kind: 'offsite',
      hasPendingRequest: false,
    });
    // Positive control: this row really does carry the destructive action.
    expect(removed).toContain('purge');
    expect(removed.at(-1)).toBe('purge');
    expect(removed.indexOf('message-owner')).toBeLessThan(removed.indexOf('purge'));
  });

  it('never appears twice on one row', () => {
    for (const status of STATUSES) {
      const actions = listingModActions({ status, kind: 'offsite', hasPendingRequest: true });
      expect(actions.filter((a) => a === 'message-owner')).toHaveLength(1);
    }
  });
});

/**
 * The full action vocabulary, IMPORTED rather than re-spelled. Every `describe` below
 * iterates THIS.
 *
 * 🔴 IT IS DERIVED FROM THE PRODUCTION ROUTE TABLE, AND THE EARLIER HAND-MAINTAINED
 * ARRAY IS WHY. That array's docstring claimed "a member added to `ListingModAction`
 * without a label / a routing decision fails here" — the label half was real (an
 * exhaustive switch), the ROUTING half was not: `actionRequiresReason` was a negation,
 * so a new member answered `true` by default, landed in the reason-gated modal, and
 * every assertion below still passed. Measured: adding a member to the union left all 46
 * unit tests green. Now a new member must appear in `LISTING_MOD_ROUTES` to exist here
 * at all — it cannot compile otherwise — and once it does, the sweeps below walk it.
 */
const ALL_ACTIONS: ListingModAction[] = ALL_LISTING_MOD_ACTIONS;

describe('action metadata', () => {
  it('only purge is destructive', () => {
    expect(isDestructiveListingModAction('purge')).toBe(true);
    for (const a of [
      'review',
      'message-owner',
      'reset-to-pending',
      'hide',
      'relist',
      'claim',
    ] as const) {
      expect(isDestructiveListingModAction(a)).toBe(false);
    }
  });

  /**
   * 🔴 `message-owner` is NOT reason-gated, and that is a claim about the SURFACE it
   * opens: `MessageAppOwnerModal` has no `reason` field at all — it has a subject and a
   * body with their own floors.
   *
   * 🔴 Stated precisely, because the looser version of this sentence was WRONG.
   * `openAction` checks `actionOpensOwnerMessage` BEFORE this predicate, so answering
   * `true` here would NOT on its own send `message-owner` to `ListingModActionModal` —
   * it would put the action in two routers at once, which the exclusivity test below is
   * what actually forbids. The mis-route this pair prevents is the one that arrives via
   * a NEW action: an action neither router claims must open nothing, and an action this
   * one claims must genuinely carry a `reason`, or `ListingModActionModal` calls its
   * proc with an input the schema rejects.
   */
  it('every mutating action except message-owner requires a reason; review requires none', () => {
    expect(actionRequiresReason('review')).toBe(false);
    expect(actionRequiresReason('message-owner')).toBe(false);
    for (const a of ['reset-to-pending', 'hide', 'relist', 'claim', 'purge'] as const) {
      expect(actionRequiresReason(a)).toBe(true);
    }
  });

  /**
   * The derived vocabulary really is the whole union. Without this, every sweep that
   * iterates `ALL_ACTIONS` would pass vacuously if the route table were ever emptied —
   * the positive control on the derivation itself, not on any one predicate.
   */
  it('the vocabulary derived from the route table is the whole union', () => {
    expect([...ALL_ACTIONS].sort()).toEqual(
      ['claim', 'hide', 'message-owner', 'purge', 'relist', 'reset-to-pending', 'review'].sort()
    );
  });

  /**
   * The two modal routers are MUTUALLY EXCLUSIVE and together they must not leave a
   * mutating action unrouted. `review` is the deliberate third case (it opens the
   * publish-request review modal, which is neither of these).
   */
  it('exactly one action opens the owner-message composer, and it opens no other modal', () => {
    const opensMessage = ALL_ACTIONS.filter(actionOpensOwnerMessage);
    expect(opensMessage).toEqual(['message-owner']);
    for (const a of ALL_ACTIONS) {
      // No action may be claimed by BOTH routers.
      expect(actionOpensOwnerMessage(a) && actionRequiresReason(a)).toBe(false);
      // And every action must be claimed by one of the three routes.
      expect(actionOpensOwnerMessage(a) || actionRequiresReason(a) || a === 'review').toBe(true);
    }
  });

  it('labels each action', () => {
    expect(listingModActionLabel('review')).toBe('Review');
    expect(listingModActionLabel('message-owner')).toBe('Message owner');
    expect(listingModActionLabel('reset-to-pending')).toBe('Reset to pending');
    expect(listingModActionLabel('hide')).toBe('Hide');
    expect(listingModActionLabel('relist')).toBe('Relist');
    expect(listingModActionLabel('claim')).toBe('Claim');
    expect(listingModActionLabel('purge')).toBe('Purge');
    // Totality: every member of the vocabulary has a non-empty, distinct label.
    const labels = ALL_ACTIONS.map(listingModActionLabel);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(ALL_ACTIONS.length);
  });

  // 🔴 THIS CHIP WAS A THIRD, DIVERGENT KIND-LABEL IMPLEMENTATION — lowercase
  // `'external'` / `'on-site'`, hardcoded, while every other surface said something
  // else. It now resolves from `listingKindLabels`; the words are pinned literally
  // here, and the file is enrolled in `standaloneWordingCallSites.test.ts`.
  it('kind chip distinguishes the two kinds, in the ONE vocabulary', () => {
    expect(listingKindChip('offsite')).toEqual({ label: 'Standalone', color: 'grape' });
    expect(listingKindChip('onsite')).toEqual({ label: 'Embedded', color: 'blue' });
  });
});

describe('effectiveModerationStatus', () => {
  it('draft WITH a live pending request → pending (awaiting first review)', () => {
    expect(effectiveModerationStatus({ status: 'draft', pendingRequest: pendingReq })).toBe(
      'pending'
    );
  });

  it('draft WITHOUT a pending request → draft (true orphan)', () => {
    expect(effectiveModerationStatus({ status: 'draft', pendingRequest: null })).toBe('draft');
  });

  it('approved → approved (unchanged)', () => {
    expect(effectiveModerationStatus({ status: 'approved', pendingRequest: null })).toBe(
      'approved'
    );
  });

  it('pending → pending (unchanged)', () => {
    expect(effectiveModerationStatus({ status: 'pending', pendingRequest: pendingReq })).toBe(
      'pending'
    );
  });

  it('removed → removed (unchanged, even if a lingering pending request exists)', () => {
    expect(effectiveModerationStatus({ status: 'removed', pendingRequest: pendingReq })).toBe(
      'removed'
    );
  });
});

/**
 * 🔴 `listingModActionsForRow` — the DTO→args mapping and its SAFE DEFAULT.
 *
 * This lived inline in `AppListingsModerationTable.tsx` and was untestable there: the browser
 * tier is the only suite that renders that component, it has no on-site orphan-draft fixture,
 * and on this host it cannot run at all. Measured — inverting the default to the permissive
 * direction left 1601 files / 25,069 tests green. These are the tests that make the mutation die.
 */
describe('listingModActionsForRow — DTO mapping and the fail-safe default', () => {
  const draftRow = (over: Record<string, unknown> = {}) => ({
    status: 'draft',
    kind: 'onsite',
    appBlockId: null,
    pendingRequest: null,
    hasPendingBlockRequest: false,
    ...over,
  });

  it('offers Purge for an orphan draft with the flag explicitly FALSE', () => {
    expect(listingModActionsForRow(draftRow())).toEqual(['message-owner', 'purge']);
  });

  it('withholds it when the flag is TRUE', () => {
    expect(listingModActionsForRow(draftRow({ hasPendingBlockRequest: true }))).toEqual([
      'message-owner',
    ]);
  });

  /**
   * 🔴 THE DEFAULT, and the only case that distinguishes `?? true` from `?? false`. A client
   * bundle from either side of a deploy can hand us a row without this field; `!undefined` is
   * truthy, so an unnormalized read would OFFER the destructive action on a listing that may be
   * under live review.
   */
  it('withholds it when the flag is ABSENT — absent means assume under review', () => {
    expect(listingModActionsForRow(draftRow({ hasPendingBlockRequest: undefined }))).toEqual([
      'message-owner',
    ]);
  });

  it('withholds it when the flag is NULL (a DTO that serialised the absence)', () => {
    expect(listingModActionsForRow(draftRow({ hasPendingBlockRequest: null }))).toEqual([
      'message-owner',
    ]);
  });

  it('derives hasPendingRequest from the pendingRequest object, not a boolean field', () => {
    // Off-site pending row: the mapping must turn a non-null object into `true` so Review shows.
    expect(
      listingModActionsForRow({
        status: 'pending',
        kind: 'offsite',
        appBlockId: null,
        pendingRequest: { id: 'alpr_1' },
        hasPendingBlockRequest: false,
      })
    ).toEqual(['review', 'message-owner']);
  });
});
