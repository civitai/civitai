// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  isSignedInBrowser,
  planDismissalRequests,
} from '~/components/Announcements/announcement-dismissal-plan';

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

  it('has nothing to send for an empty dismissal', () => {
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

describe('isSignedInBrowser', () => {
  afterEach(() => {
    delete (window as { isAuthed?: boolean }).isAuthed;
  });

  /**
   * 🔴 The property name is the whole guard, and it is the one thing `planDismissalRequests`
   * cannot see. `CivitaiSessionProvider` sets `window.isAuthed`; read anything else and no
   * dismissal is ever recorded, for anyone, with every other test in this file still green.
   */
  it('reads the flag the session provider actually sets', () => {
    (window as { isAuthed?: boolean }).isAuthed = true;

    expect(isSignedInBrowser()).toBe(true);
  });

  it('is false before the session provider has run', () => {
    expect(isSignedInBrowser()).toBe(false);
  });
});
