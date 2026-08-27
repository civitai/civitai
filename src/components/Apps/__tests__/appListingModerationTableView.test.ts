import { describe, expect, it } from 'vitest';

import {
  actionOpensOwnerMessage,
  actionRequiresReason,
  effectiveModerationStatus,
  isDestructiveListingModAction,
  listingKindChip,
  listingModActionLabel,
  listingModActions,
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
      listingModActions({ status: 'pending', kind: 'offsite', hasPendingRequest: true })
    ).toEqual(['review', 'message-owner']);
  });

  it('approved → Reset to pending + Hide', () => {
    expect(
      listingModActions({ status: 'approved', kind: 'offsite', hasPendingRequest: false })
    ).toEqual(['message-owner', 'reset-to-pending', 'hide']);
  });

  it('removed → Relist + Claim + Purge', () => {
    expect(
      listingModActions({ status: 'removed', kind: 'offsite', hasPendingRequest: false })
    ).toEqual(['message-owner', 'relist', 'claim', 'purge']);
  });

  it('draft → no lifecycle action (unless a pending request offers Review)', () => {
    expect(
      listingModActions({ status: 'draft', kind: 'offsite', hasPendingRequest: false })
    ).toEqual(['message-owner']);
    expect(
      listingModActions({ status: 'draft', kind: 'offsite', hasPendingRequest: true })
    ).toEqual(['review', 'message-owner']);
  });

  it('rejected → read-only apart from Message owner', () => {
    expect(
      listingModActions({ status: 'rejected', kind: 'offsite', hasPendingRequest: false })
    ).toEqual(['message-owner']);
  });
});

describe('listingModActions — on-site rows hide the off-site-only actions', () => {
  it('approved on-site → Reset to pending + Hide (reset is now dual-kind, #3165)', () => {
    expect(
      listingModActions({ status: 'approved', kind: 'onsite', hasPendingRequest: false })
    ).toEqual(['message-owner', 'reset-to-pending', 'hide']);
  });

  it('removed on-site → Relist ONLY (no claim / purge)', () => {
    expect(
      listingModActions({ status: 'removed', kind: 'onsite', hasPendingRequest: false })
    ).toEqual(['message-owner', 'relist']);
  });

  it('pending on-site → NO Review (approve/reject is off-site only; onsite uses its own queue)', () => {
    expect(
      listingModActions({ status: 'pending', kind: 'onsite', hasPendingRequest: true })
    ).toEqual(['message-owner']);
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

  it('appears for every status × kind × pending-request combination', () => {
    const missing: string[] = [];
    for (const status of STATUSES) {
      for (const kind of KINDS) {
        for (const hasPendingRequest of [true, false]) {
          const actions = listingModActions({ status, kind, hasPendingRequest });
          if (!actions.includes('message-owner')) {
            missing.push(`${kind}/${status}/pending=${hasPendingRequest}`);
          }
        }
      }
    }
    // Positive control on the enumeration itself: 5 statuses × 2 kinds × 2 = 20 cases
    // were actually walked, so an empty `missing` is a real sweep and not an empty loop.
    expect(STATUSES.length * KINDS.length * 2).toBe(20);
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
 * The full action vocabulary, spelled once. Every `describe` below iterates THIS, so a
 * member added to `ListingModAction` without a label / a routing decision fails here
 * rather than rendering an empty button or falling through both modal branches.
 */
const ALL_ACTIONS: ListingModAction[] = [
  'review',
  'message-owner',
  'reset-to-pending',
  'hide',
  'relist',
  'claim',
  'purge',
];

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
