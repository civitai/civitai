import { describe, expect, it } from 'vitest';

import { planDismissalRequests } from '~/components/Announcements/announcement-dismissal-plan';

describe('planDismissalRequests', () => {
  /**
   * 🔴 The signed-out guard. Anonymous visitors dismiss site announcements — the cookie has
   * always carried that and still does — and the procedure behind this is protected, so a
   * request here is a 401 per dismissal for every logged-out user on the site.
   *
   * Reverting the guard turns this into `[[1, 2]]`, which is what the assertion prints.
   */
  it('sends nothing when the visitor is signed out', () => {
    expect(planDismissalRequests({ ids: [1, 2], isAuthed: false, batchSize: 100 })).toEqual([]);
  });

  it('sends one request for a signed-in dismissal', () => {
    expect(planDismissalRequests({ ids: [1, 2], isAuthed: true, batchSize: 100 })).toEqual([
      [1, 2],
    ]);
  });

  it('sends nothing when there is nothing to dismiss', () => {
    expect(planDismissalRequests({ ids: [], isAuthed: true, batchSize: 100 })).toEqual([]);
  });

  // The schema rejects an oversized list outright, so an unbatched dismiss-all would be
  // dropped whole — locally dismissed, never recorded, and silent because the call is
  // fire-and-forget.
  it('splits a list larger than one request into full batches plus a remainder', () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);

    const batches = planDismissalRequests({ ids, isAuthed: true, batchSize: 100 });

    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(ids);
  });
});
