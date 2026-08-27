import { describe, expect, it } from 'vitest';
import { SHARED_ALLOWANCE_NOTE } from '~/shared/utils/placement';
import { requiresImageDbPath } from '~/server/schema/image.schema';
import type { RemixGalleryItem } from '~/components/RemixGallery/remix-gallery.utils';
import {
  dedupeGalleryItems,
  freeRefusalExplanation,
  freeRefusalOutcome,
  freeSubmissionOffer,
  galleryDialogImages,
  paidSubmissionOpen,
  remixGalleryModerating,
  remixSubmitPickerFilters,
  submissionMethod,
  trimToWholeRows,
} from '~/components/RemixGallery/remix-gallery.utils';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';

describe('what a refused free submission is told', () => {
  const stillOffered = {
    verified: true,
    freeSlots: 3,
    freeSlotsRemaining: 2,
    allowanceRemaining: 1,
    usedHere: false,
    resetsAt: new Date('2026-03-04T00:00:00Z'),
    paidOpen: true,
  };

  it('explains nothing when the re-read says free was still on offer', () => {
    // 🔴 The null is the fix. `freeSubmissionOffer` always has an answer, so a
    // caller asking it AFTER a refusal is always given one — and the free path
    // is refused for at least a dozen reasons it cannot see: unverified, a
    // duplicate entry, an unpublished image, the content rule, a block, a
    // moderator suspension. A shape that cannot say "I don't know" reports every
    // one of those as whichever rung happens to be lowest.
    expect(freeRefusalExplanation(stillOffered)).toBeNull();
  });

  it('explains a refusal the re-read does account for', () => {
    expect(freeRefusalExplanation({ ...stillOffered, freeSlotsRemaining: 0 })).toMatch(
      /all taken right now/i
    );
  });

  it('shows the server’s own words when nothing explains it', () => {
    // The message the careful copy lives in. Without this branch,
    // `FREE_NEEDS_VERIFIED_REFUSAL` — the sentence explaining why paying is the
    // alternative — reaches nobody, because this handler is its only path.
    const outcome = freeRefusalOutcome(
      null,
      'remix gallery: free submissions are for remixes…',
      true
    );

    expect(outcome.message).toBe('remix gallery: free submissions are for remixes…');
    expect(outcome.title).toMatch(/couldn't submit/i);
  });

  it('does NOT move the control to paid on an unexplained refusal', () => {
    // Settling on paid asserts that money was the problem. For a blocked or
    // suspended placer it is not: they press the paid button and meet the same
    // refusal, having been told the opposite of what is wrong.
    expect(
      freeRefusalOutcome(null, 'remix gallery: you cannot place right now', true).fallBackToPaid
    ).toBe(false);
  });

  it('treats an EMPTY explanation as explained, not as unexplained', () => {
    // The guard is `explained !== null` and the comment says why; nothing
    // asserted it, because no rung returns ''. Under truthiness an empty rung
    // would take the branch that means "we could not explain this" and hand the
    // submitter raw server prose instead.
    expect(freeRefusalOutcome('', 'server prose', true)).toMatchObject({
      fallBackToPaid: true,
    });
    expect(freeRefusalOutcome('', 'server prose', true).message).not.toContain('server prose');
  });

  it('moves the control to paid when the refusal WAS about free capacity', () => {
    // Every rung is a limit on free capacity that Buzz is not subject to, so
    // here the fall-back is a true statement about the next step.
    const outcome = freeRefusalOutcome(
      'The free slots on this image are all taken right now.',
      'x',
      true
    );

    expect(outcome.fallBackToPaid).toBe(true);
    expect(outcome.message).toMatch(/all taken right now/i);
    expect(outcome.message).toMatch(/still submit with Buzz/i);
  });

  it('does not recommend Buzz on a gallery that refuses paid submissions', () => {
    // 🔴 The two paths are deliberately asymmetric: the service holds free to
    // none of the price rules, so an unpriced or below-floor gallery accepts
    // free and refuses paid. Recommending Buzz there sends someone to a disabled
    // button or into a second refusal.
    const outcome = freeRefusalOutcome(
      'The free slots on this image are all taken right now.',
      'x',
      false
    );

    expect(outcome.fallBackToPaid).toBe(false);
    expect(outcome.message).not.toMatch(/still submit with Buzz/i);
    expect(outcome.message).toMatch(/not taking paid submissions/i);
  });
});

describe('submissionMethod', () => {
  it('defaults to free when free is available, and to paid when it is not', () => {
    expect(submissionMethod(null, true, true, true)).toBe('free');
    expect(submissionMethod(null, false, true, true)).toBe('paid');
  });

  it('honours an explicit choice', () => {
    expect(submissionMethod('paid', true, true, true)).toBe('paid');
    expect(submissionMethod('free', true, true, true)).toBe('free');
  });

  it('never resolves to free once free stops being available', () => {
    // The half that survives losing the race for the last slot: `chosen` still
    // says free, the fresh numbers no longer do, and the control must not submit
    // free anyway.
    expect(submissionMethod('free', false, true, true)).toBe('paid');
  });

  it('falls through to paid when NEITHER path is open', () => {
    // Nothing to hold on. Forcing free here renders a disabled "Submit for
    // free" on a gallery that takes none; paid-disabled-beside-the-reason is
    // the honest rendering of "no route in".
    expect(submissionMethod(null, false, false, false)).toBe('paid');
  });

  it.each([
    ['a stale free choice', 'free' as const, false],
    ['an explicit paid choice', 'paid' as const, true],
    ['no choice at all', null, false],
  ])('stays on free when paid is closed — %s', (_label, chosen, freeAvailable) => {
    // 🔴 Falling to paid is only honest when paid exists. On a gallery that
    // takes free submissions and refuses every paid one, dropping to paid lands
    // on a disabled button with no explanation, or on an enabled one that opens
    // the buy-Buzz flow for a submission the server will refuse.
    //
    // Every route into paid is covered, because each is a different line: the
    // stale-choice rule, an explicit press, and the default.
    expect(submissionMethod(chosen, freeAvailable, false, true)).toBe('free');
  });
});

describe('paidSubmissionOpen', () => {
  // Mirrors the two refusals the paid path makes, which `open` does not cover —
  // that is `mode !== 'off'` and says nothing about price.
  it.each([
    ['unpriced', null],
    ['undefined while loading', undefined],
    ['below the surface floor', PLACEMENT_SURFACES.remixGallery.serverMinPrice - 1],
  ])('is closed when %s', (_label, price) => {
    expect(paidSubmissionOpen(price)).toBe(false);
  });

  it.each([
    ['exactly at the floor', PLACEMENT_SURFACES.remixGallery.serverMinPrice],
    ['above it', PLACEMENT_SURFACES.remixGallery.serverMinPrice + 10],
  ])('is open when priced %s', (_label, price) => {
    expect(paidSubmissionOpen(price)).toBe(true);
  });
});

describe('freeSubmissionOffer', () => {
  const RESETS_AT = new Date('2026-03-04T00:00:00Z');

  /** Everything satisfied, so each case below breaks exactly one thing. */
  const eligible = {
    verified: true,
    freeSlots: 3,
    freeSlotsRemaining: 2,
    allowanceRemaining: 1,
    usedHere: false,
    resetsAt: RESETS_AT,
    paidOpen: true,
  };

  /** Each condition on its own, so a pair can be built by merging two. */
  const broken = {
    verified: { verified: false },
    usedHere: { usedHere: true },
    freeSlots: { freeSlots: 0, freeSlotsRemaining: 0 },
    allowanceRemaining: { allowanceRemaining: 0 },
    freeSlotsRemaining: { freeSlotsRemaining: 0 },
  } as const;

  /**
   * The ladder, longest-lasting refusal first, with the fragment each one owns.
   *
   * The order is the design: a refusal that lifts tonight must never be reported
   * over one that never lifts, or someone comes back tomorrow to be told the
   * thing nobody told them today.
   */
  const ladder = [
    ['verified', /where we can check/i],
    ['usedHere', /once per gallery/i],
    ['freeSlots', /doesn't take free/i],
    ['allowanceRemaining', /used today's free placement/i],
    ['freeSlotsRemaining', /all taken right now/i],
  ] as const;

  it.each(ladder.slice(0, -1).map((entry, index) => [entry[0], ladder[index + 1][0]] as const))(
    'reports %s ahead of %s when BOTH are true',
    (first, second) => {
      // Both set at once, which is the only way an ordering can be asserted.
      // Fixtures that break one condition at a time pass under any order, so
      // the two-line swap that inverts the ladder would go unnoticed.
      const expected = ladder.find(([name]) => name === first)![1];
      const { available, reason } = freeSubmissionOffer({
        ...eligible,
        ...broken[first],
        ...broken[second],
      });

      // `available` on every branch, not only on the happy one. The modal reads
      // it to decide whether the free button works, and a rung returning a
      // refusal reason alongside `available: true` would offer a submission the
      // claim then refuses — the state the docstring calls impossible and which
      // nothing asserted on four of six outcomes.
      expect(available).toBe(false);
      expect(reason).toMatch(expected);
    }
  );

  it.each(ladder.map((entry, index) => [entry[0], index] as const))(
    'reports %s over every rung BELOW it, all set at once',
    (name, index) => {
      // A suffix cascade rather than one all-true case. All-true asserts only
      // that rung 1 wins, so a swap anywhere among the rest leaves it green —
      // it reads as a transitivity check and is not one. Breaking every rung
      // from this one down, for each rung in turn, is the check that
      // discriminates: any reordering changes at least one winner.
      const { available, reason } = freeSubmissionOffer(
        ladder
          .slice(index)
          .reduce((input, [rung]) => ({ ...input, ...broken[rung] }), { ...eligible })
      );

      expect(available).toBe(false);
      expect(reason).toMatch(ladder[index][1]);
    }
  );

  it('reads the reset moment off the server date rather than naming a timezone', () => {
    // "midnight UTC" is true of the rule and misleading to a person, and it is a
    // server-side rule this file must not restate — raise the reset and a
    // hardcoded sentence goes quietly false.
    const { reason } = freeSubmissionOffer({ ...eligible, ...broken.allowanceRemaining });

    expect(reason).not.toMatch(/UTC/i);
    expect(reason).toContain(
      RESETS_AT.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    );
  });

  it('offers free when every condition holds', () => {
    expect(freeSubmissionOffer(eligible)).toEqual({ available: true, reason: null });
  });

  it('refuses an unverified remix and names paying as the alternative', () => {
    const { available, reason } = freeSubmissionOffer({ ...eligible, verified: false });

    expect(available).toBe(false);
    expect(reason).toMatch(/with Buzz/i);
    // It must not call an off-site remix "not a remix": that is both wrong and
    // an accusation, and it is the case a submitter is most likely to hit on
    // work they know they made.
    expect(reason).not.toMatch(/not a remix|isn't a remix/i);
  });

  it('does not name paying when paid is closed either', () => {
    // 🔴 `freeRefusalOutcome` got this a round earlier and this rung did not.
    // On an unpriced or below-floor gallery the card holds on free with every
    // control disabled and no Buzz button mounted at all, so pointing at one is
    // pointing off the screen — and at a submission the server would refuse.
    const { reason } = freeSubmissionOffer({ ...eligible, verified: false, paidOpen: false });

    expect(reason).toMatch(/where we can check/i);
    expect(reason).not.toMatch(/can still be submitted with Buzz/i);
    expect(reason).toMatch(/not taking paid submissions/i);
  });

  it('leads with verification even when a slot shortage is also true', () => {
    // Order is the whole design here. Naming the shortage would send someone
    // back tomorrow to be refused for the reason they were refused today.
    const { reason } = freeSubmissionOffer({
      ...eligible,
      verified: false,
      freeSlotsRemaining: 0,
      allowanceRemaining: 0,
      usedHere: true,
    });

    expect(reason).toMatch(/where we can check/i);
  });

  it('tells the two meanings of "no slots remaining" apart', () => {
    // `freeSlotsRemaining: 0` covers both "this creator takes none" and "they
    // are all held right now" — the resolver short-circuits the count at zero
    // capacity — and the difference decides whether coming back later helps.
    const takesNone = freeSubmissionOffer({ ...eligible, freeSlots: 0, freeSlotsRemaining: 0 });
    const allHeld = freeSubmissionOffer({ ...eligible, freeSlots: 3, freeSlotsRemaining: 0 });

    expect(takesNone.reason).toMatch(/doesn't take free/i);
    expect(allHeld.reason).toMatch(/all taken right now/i);
    expect(takesNone.reason).not.toBe(allHeld.reason);
  });

  it('separates a spent daily allowance from a gallery already used', () => {
    // One comes back at midnight and the other never does, so a single message
    // for both would tell half of them to wait for something that will not
    // happen.
    expect(freeSubmissionOffer({ ...eligible, allowanceRemaining: 0 }).reason).toMatch(
      /comes back at/i
    );
    expect(freeSubmissionOffer({ ...eligible, usedHere: true }).reason).toMatch(
      /once per gallery/i
    );
  });
});

const items = (count: number, startId = 1) =>
  Array.from({ length: count }, (_, index) => ({
    placementId: startId + index,
    placerId: 1,
    pinned: false,
    image: { id: startId + index },
  })) as unknown as RemixGalleryItem[];

describe('dedupeGalleryItems', () => {
  it('keeps the first occurrence when a page repeats a placement', () => {
    // The server has already shipped one cursor bug that returned a pinned
    // entry on two consecutive pages. Two cards would then share a React key,
    // and the row trimming below would count the duplicate toward a row it does
    // not fill.
    const [a, b] = items(2);
    expect(dedupeGalleryItems([a, b, a]).map((item) => item.placementId)).toEqual([1, 2]);
  });

  it('leaves a page with no repeats untouched', () => {
    const page = items(4);
    expect(dedupeGalleryItems(page)).toEqual(page);
  });

  it('returns nothing for an empty gallery', () => {
    expect(dedupeGalleryItems([])).toEqual([]);
  });
});

describe('trimToWholeRows', () => {
  it('drops a partial trailing row', () => {
    expect(trimToWholeRows([1, 2, 3, 4, 5, 6], 4)).toEqual([1, 2, 3, 4]);
  });

  it('keeps an exact number of rows intact', () => {
    expect(trimToWholeRows([1, 2, 3, 4, 5, 6, 7, 8], 4)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // The regression this exists for: trimming a below-one-row gallery to whole
  // rows empties it, which hides every gallery that has fewer entries than one
  // row — i.e. every gallery on its first day.
  it('keeps a partial row when it is the only row', () => {
    expect(trimToWholeRows([1, 2], 4)).toEqual([1, 2]);
    expect(trimToWholeRows([1], 4)).toEqual([1]);
  });

  it('returns nothing for an empty gallery', () => {
    expect(trimToWholeRows([], 4)).toEqual([]);
  });
});

describe('galleryDialogImages', () => {
  it('returns the gallery images so the dialog browses the gallery', () => {
    const result = galleryDialogImages(2, items(3));
    expect(result.map((image) => image.id)).toEqual([1, 2, 3]);
  });

  // An empty set makes the dialog fall back to its own query, which browses the
  // feed behind the gallery instead of the gallery.
  it('returns an empty window when the image is not in the set', () => {
    expect(galleryDialogImages(99, items(3))).toEqual([]);
  });

  it('windows a large gallery around the clicked image', () => {
    const result = galleryDialogImages(120, items(300));
    expect(result).toHaveLength(100);
    expect(result[0].id).toBe(70);
    expect(result[result.length - 1].id).toBe(169);
  });
});

describe('remixSubmitPickerFilters', () => {
  // Both of these were reported from the picker: a moderator was offered their
  // own drafts, which the submit mutation refuses, and the grid opened on a
  // year-old image because the feed sorts by reactions unless told otherwise.
  // Neither is visible in a rendered grid — a picker missing them looks like a
  // picker.
  it('asks for published images only', () => {
    expect(remixSubmitPickerFilters(7).publishedOnly).toBe(true);
  });

  it('asks for the newest first, not the feed default', () => {
    expect(remixSubmitPickerFilters(7).sort).toBe('Newest');
  });

  it('scopes the picker to the submitter', () => {
    // The picker offers your own work to submit. Dropping this would offer
    // everyone's, and every one of them would be refused.
    expect(remixSubmitPickerFilters(7).userId).toBe(7);
  });

  // 🔴 To whoever is about to simplify this: the pair of `userId` and
  // `publishedOnly` is not two independent preferences that happen to sit next
  // to each other. Together they are the signal `requiresImageDbPath` reads to
  // route this picker off the search index and onto the database, and that
  // routing is the whole reason a freshly published image appears here at all.
  // Measured on prod 2026-08-27: an image is absent from `metrics_images_v1`
  // for 10-30 minutes after publish, while it is `Scanned` and carries an
  // `nsfwLevel` inside the first minute. Someone posts an image, opens this
  // picker to submit it, and the one image they came for is the one missing.
  // Drop either half and the picker silently goes back to the index — the grid
  // still renders, still returns rows, and the only symptom is the newest
  // image not being there.
  it('routes the picker to the database, not the search index', () => {
    expect(requiresImageDbPath(remixSubmitPickerFilters(7))).toBe(true);
  });

  it('needs both halves to route to the database', () => {
    // The control for the assertion above: it is the PAIR that routes, so
    // neither half alone may. `publishedOnly` alone would be a broad-feed
    // escape hatch anyone could type into a URL; `userId` alone is an ordinary
    // profile feed the index serves fine.
    expect(requiresImageDbPath({ publishedOnly: true })).toBe(false);
    expect(requiresImageDbPath({ userId: 7 })).toBe(false);
  });
});

describe('remixGalleryModerating', () => {
  const base = { isModerator: true, isOwner: false, ownerKnown: true, asModerator: false };

  it('moderates another creator gallery without being asked', () => {
    // There is no creator role available there, so there is nothing to choose.
    expect(remixGalleryModerating(base)).toBe(true);
  });

  it('leaves a moderator on their own gallery under the creator rules by default', () => {
    expect(remixGalleryModerating({ ...base, isOwner: true })).toBe(false);
  });

  it('moderates your own gallery only when you ask', () => {
    expect(remixGalleryModerating({ ...base, isOwner: true, asModerator: true })).toBe(true);
  });

  it('gives a non-moderator nothing, whatever they claim', () => {
    expect(remixGalleryModerating({ ...base, isModerator: false, asModerator: true })).toBe(false);
  });

  // 🔴 The reason this is a function at all. `isOwner` comes from a query and is
  // `false` while it is in flight, which is indistinguishable from a stranger's
  // gallery — so a moderator opening their OWN gallery moderated it for as long
  // as that query took, and a removal in that window kept the submitter's Buzz.
  it('refuses to moderate anything until it knows whose gallery this is', () => {
    expect(remixGalleryModerating({ ...base, ownerKnown: false })).toBe(false);
  });

  it('stays refused while unknown even when the mode was explicitly asked for', () => {
    expect(
      remixGalleryModerating({ ...base, ownerKnown: false, isOwner: true, asModerator: true })
    ).toBe(false);
  });
});

/**
 * 🔴 The cross-surface guard, on the surface that would drift silently.
 *
 * The whole point of one shared constant is that a placer who spends their day
 * on a remix gallery meets the same description of the budget on the sticker
 * side. The sticker half is pinned in `free-offer.test.ts`; without this, the
 * remix half could drop the clause and every test in the repo would stay green.
 */
describe('the remix surface names the shared budget too', () => {
  it('says what the allowance is shared with when it is spent', () => {
    const spent = freeSubmissionOffer({
      verified: true,
      freeSlots: 1,
      freeSlotsRemaining: 1,
      allowanceRemaining: 0,
      usedHere: false,
      resetsAt: new Date('2026-08-21T00:00:00.000Z'),
      paidOpen: true,
    });

    expect(spent.reason).toContain(SHARED_ALLOWANCE_NOTE);
  });
});
