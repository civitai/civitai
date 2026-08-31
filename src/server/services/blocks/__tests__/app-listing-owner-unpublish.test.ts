import { describe, expect, it, vi } from 'vitest';

import { OWNER_UNPUBLISH_ACTION } from '~/components/Apps/offsiteOwnerControls';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import {
  isOwnerUnpublishAction,
  isOwnerUnpublishedListing,
  LISTING_STATUS_CHANGING_MODERATION_ACTIONS,
  OWNER_UNPUBLISH_EVENT,
  readLastModerationAction,
  STATE_NEUTRAL_MODERATION_ACTIONS,
} from '~/server/services/blocks/app-listing-owner-unpublish';

/**
 * The single spelling of "did the OWNER take this listing down, or did a MODERATOR?".
 *
 * `app_listings.status = 'removed'` cannot answer that — both writers produce it — so the
 * answer comes from the most-recent `AppListingModerationEvent`. This module is the one
 * place that question is asked; `republishOwnListing`'s go-live guard and the three author
 * edit paths in `offsite-listing.service` all read it from here.
 */

function fakeClient(row: { action: string } | null) {
  const findFirst = vi.fn(async (..._a: unknown[]) => row);
  return { client: { appListingModerationEvent: { findFirst } }, findFirst };
}

describe('isOwnerUnpublishAction', () => {
  it("the owner's own unpublish is the ONLY action that answers true", () => {
    expect(isOwnerUnpublishAction('owner-unpublish')).toBe(true);
  });

  it.each([
    'delist',
    'purge',
    'owner-republish',
    'relist',
    'approve',
    'reject',
    'reset-to-pending',
    'claim',
    // Near-misses that a substring/prefix test would wrongly admit.
    'owner-unpublished',
    'not-owner-unpublish',
    'OWNER-UNPUBLISH',
  ])('%s ⇒ false', (action) => {
    expect(isOwnerUnpublishAction(action)).toBe(false);
  });

  it('🔴 FAILS CLOSED on absence: null / undefined ⇒ false', () => {
    expect(isOwnerUnpublishAction(null)).toBe(false);
    expect(isOwnerUnpublishAction(undefined)).toBe(false);
  });

  it('names the action with the exported constant, so callers cannot re-spell it', () => {
    expect(OWNER_UNPUBLISH_EVENT).toBe('owner-unpublish');
  });

  /**
   * The CLIENT keeps its own literal (`OWNER_UNPUBLISH_ACTION` in
   * `~/components/Apps/offsiteOwnerControls`) rather than importing this module, which is
   * server-side and pulls the moderation schema with it. That is a deliberate bundle
   * decision, not an accident — but it leaves two spellings of one action, and two
   * literals are how the Republish button and the server gate drift apart. This is the
   * seam that keeps them equal.
   */
  it('🔴 the CLIENT literal is the same string as the SERVER constant', () => {
    expect(OWNER_UNPUBLISH_ACTION).toBe(OWNER_UNPUBLISH_EVENT);
    expect(isOwnerUnpublishAction(OWNER_UNPUBLISH_ACTION)).toBe(true);
  });
});

describe('LISTING_STATUS_CHANGING_MODERATION_ACTIONS', () => {
  /**
   * 🔴 BOTH HALVES ARE HARDCODED LITERALS, AND THAT IS WHAT MAKES THE ASSERTION BELOW
   * MEAN ANYTHING. `STATE_NEUTRAL_MODERATION_ACTIONS` was briefly the DERIVED complement
   * (`APP_LISTING_MODERATION_ACTIONS.filter(a => !CHANGING.includes(a))`). Under that
   * construction union-equals-taxonomy, empty-intersection and size-sum are all
   * TAUTOLOGIES: a new verb lands in the neutral half automatically and every assertion
   * still holds. Measured — adding `'suspend'` to the taxonomy left 33 passing / 0
   * failing. The guard read as coverage and provided none, which is worse than none.
   *
   * The hazard it was supposed to stop is real and FAIL-OPEN: a new status-CHANGING
   * takedown verb omitted from `LISTING_STATUS_CHANGING_MODERATION_ACTIONS` is filtered
   * OUT of `readLastModerationAction`'s WHERE clause, so an older `owner-unpublish`
   * resurfaces beneath the moderator's takedown and the owner regains edit +
   * `republishOwnListing` on content that was just removed.
   *
   * With both halves written out, a new verb is a member of NEITHER, so the union
   * assertion goes RED and the classification has to be made out loud.
   * `APP_LISTING_MODERATION_ACTIONS` is itself pinned against the migration's CHECK
   * IN-list by `app-listing-mod-action.constants.test.ts`, so this chains to the DB.
   */
  it('🔴 partitions the FULL action taxonomy: status-changing ∪ state-neutral = all, ∩ = ∅', () => {
    const changing = new Set<string>(LISTING_STATUS_CHANGING_MODERATION_ACTIONS);
    const neutral = new Set<string>(STATE_NEUTRAL_MODERATION_ACTIONS);

    expect([...changing].filter((a) => neutral.has(a))).toEqual([]);
    expect(new Set([...changing, ...neutral])).toEqual(new Set(APP_LISTING_MODERATION_ACTIONS));
    // No duplicates hiding inside either half.
    expect(changing.size + neutral.size).toBe(APP_LISTING_MODERATION_ACTIONS.length);
  });

  /**
   * INVARIANT GUARD (not regression coverage — it passed before this change too, because
   * the derived complement produced exactly this list). It exists to pin the two halves
   * as WHOLE ARRAYS so a member cannot be quietly dropped from one and appear in the
   * other while the partition assertion above stays satisfied.
   *
   * 🔴 ORDER IS ASSERTED TOO, AND THIS IS THE ONLY TEST THAT SEES A REORDER. An earlier
   * version of this comment justified that by claiming the order keeps the pinned SQL text
   * in `offsite-listing.edit.service.test.ts` deterministic. That is FALSE and is corrected
   * rather than softened: the statement is pinned as `... AND action IN (?,?,?,?,?,?)`, so
   * only the COUNT of the verbs reaches the text — the values are bound parameters and the
   * pin is order-insensitive by construction. The companion assertion there,
   * `expect(values).toEqual(['apl_removed', ...LISTING_STATUS_CHANGING_MODERATION_ACTIONS])`,
   * derives its own expectation from the same constant, so it moves WITH a reorder and
   * cannot see one either. Measured: reordering the constant leaves both of those GREEN and
   * is caught here and nowhere else.
   *
   * What the order assertion actually buys, then, is a REVIEW property, not a runtime one:
   * the two halves are written out as literals, so a reorder or a membership change shows up
   * as a diff on this list and has to be looked at, instead of being absorbed silently by
   * assertions computed from the constant itself.
   */
  it('pins BOTH halves as whole literal arrays, so neither can be silently re-derived', () => {
    expect([...LISTING_STATUS_CHANGING_MODERATION_ACTIONS]).toEqual([
      'delist',
      'relist',
      'purge',
      'reset-to-pending',
      'owner-unpublish',
      'owner-republish',
    ]);
    expect([...STATE_NEUTRAL_MODERATION_ACTIONS]).toEqual([
      'claim',
      'report-resolve',
      'report-dismiss',
      'message-owner',
    ]);
  });

  it.each(['delist', 'relist', 'purge', 'reset-to-pending', 'owner-unpublish', 'owner-republish'])(
    '%s WRITES app_listings.status ⇒ status-changing',
    (action) => {
      expect(LISTING_STATUS_CHANGING_MODERATION_ACTIONS as readonly string[]).toContain(action);
    }
  );

  it.each([
    // A moderator writing to the owner ("fix X and republish") — the workflow that made
    // an unfiltered last-event read revoke the very repair loop this arc adds.
    'message-owner',
    // A REPORT's status flips; the listing's does not.
    'report-resolve',
    'report-dismiss',
    // The listing's `userId` moves; its `status` does not.
    'claim',
  ])(
    '%s leaves app_listings.status alone ⇒ state-neutral, and must NOT displace a removal',
    (action) => {
      expect(LISTING_STATUS_CHANGING_MODERATION_ACTIONS as readonly string[]).not.toContain(action);
      expect(STATE_NEUTRAL_MODERATION_ACTIONS as readonly string[]).toContain(action);
    }
  );
});

describe('readLastModerationAction', () => {
  it('🔴 orders newest-first with the id tiebreak and selects `action` + `before`', async () => {
    // `createdAt` alone is not a total order — two events written in one transaction
    // share a timestamp, and without the id tiebreak "most recent" is whichever row the
    // planner returned first, which flips an owner capability on and off at random.
    const { client, findFirst } = fakeClient({ action: 'delist' });

    await readLastModerationAction(client, 'apl_x');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        appListingId: 'apl_x',
        action: { in: [...LISTING_STATUS_CHANGING_MODERATION_ACTIONS] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // `before` rides along because the owner-republish asset-review gate needs the verb
      // and the payload to come from the SAME row — see
      // `readLastStatusChangingModerationEvent`. Reading them in two queries would let a
      // concurrent write pair one event's verb with another's payload.
      select: { action: true, before: true },
    });
  });

  it('🔴 FILTERS IN THE QUERY: every state-neutral action is excluded by the WHERE clause', async () => {
    // The filter must be a `where`, not a post-hoc test on one fetched row: "the newest
    // STATUS-CHANGING event" is not derivable from "the newest event of any kind" — if
    // the newest row is a `message-owner`, a post-filter yields null (fail-closed, but
    // WRONG: it hides the owner's real `owner-unpublish` underneath).
    const { client, findFirst } = fakeClient({ action: 'owner-unpublish' });

    await readLastModerationAction(client, 'apl_x');

    const where = (findFirst.mock.calls[0]?.[0] as { where: { action: { in: string[] } } }).where;
    for (const neutral of STATE_NEUTRAL_MODERATION_ACTIONS) {
      expect(where.action.in).not.toContain(neutral);
    }
    // Positive control on the same read: the query is not simply empty.
    expect(where.action.in).toContain('owner-unpublish');
    expect(where.action.in).toContain('delist');
  });

  it('returns the action, and null when the listing has no events', async () => {
    expect(await readLastModerationAction(fakeClient({ action: 'delist' }).client, 'apl_x')).toBe(
      'delist'
    );
    expect(await readLastModerationAction(fakeClient(null).client, 'apl_x')).toBeNull();
  });
});

describe('isOwnerUnpublishedListing', () => {
  it.each([
    ['owner-unpublish', true],
    ['delist', false],
    ['purge', false],
  ] as const)('last event %s ⇒ %s', async (action, expected) => {
    expect(await isOwnerUnpublishedListing(fakeClient({ action }).client, 'apl_x')).toBe(expected);
  });

  it('🔴 no events at all ⇒ false (a removal nothing proves the owner made)', async () => {
    expect(await isOwnerUnpublishedListing(fakeClient(null).client, 'apl_x')).toBe(false);
  });
});
