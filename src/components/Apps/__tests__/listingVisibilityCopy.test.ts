import { describe, expect, it } from 'vitest';

import {
  visibilityCeilingReason,
  visibilityLevelDescription,
  visibilityLevelLabel,
  visibilityOptionsFor,
  visibilityPostApprovalPrompt,
  visibilitySummaryLabel,
} from '~/components/Apps/listingVisibilityCopy';
import {
  APP_LISTING_VISIBILITIES,
  maxVisibilityForStatus,
} from '~/shared/utils/app-listing-visibility';

/**
 * 🔴 WHY THESE LIVE IN THE BLOCKING `unit` PROJECT. The panel that renders them is covered
 * only by browser-mode, which is REPORT-ONLY in CI and cannot run on this workstation at
 * all (the nix `playwright-browsers` layout does not match the npm package's expected
 * revision, so `browserType.launch` fails outright). A copy claim asserted only in a
 * `.tsx` branch is therefore a claim nothing blocking ever checks — and two of the claims
 * below are the ones the design round called out explicitly: `private` must not promise
 * access control, and a level above the ceiling must say WHY.
 */

const ELIGIBLE = ['draft', 'pending', 'approved'];
const INELIGIBLE = ['rejected', 'removed'];

describe('visibilityLevelLabel / visibilityLevelDescription', () => {
  it('covers every level in the enum, with no fallthrough', () => {
    // 🔴 SET-DRIVEN FROM THE ENUM, so a fifth level added server-side fails here instead of
    // rendering `undefined` in a selector. Both functions are exhaustive switches; a new
    // member makes them non-exhaustive at the type level AND empty at runtime.
    for (const level of APP_LISTING_VISIBILITIES) {
      expect(visibilityLevelLabel(level)).toBeTruthy();
      expect(visibilityLevelDescription(level)).toBeTruthy();
    }
    // Pairwise-distinct labels — a selector whose options share a label is unusable, and a
    // copy/paste in the switch is the obvious way to produce one.
    const labels = APP_LISTING_VISIBILITIES.map(visibilityLevelLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('🔴 describes `private` as DISCOVERABILITY, never as access control', () => {
    // 🔴 THE LOAD-BEARING COPY ASSERTION ON THIS SURFACE. The column is read by the STORE
    // read only; the run route never consults it. So anyone holding the URL can still open
    // a `private` listing, and copy implying otherwise is a security promise the system
    // does not make. Asserted both ways: the true claim present, the false ones absent.
    const d = visibilityLevelDescription('private').toLowerCase();
    expect(d).toContain('link');
    expect(d).toMatch(/not listed|not discoverable/);
    for (const forbidden of [
      'nobody',
      'no one',
      'only you',
      'cannot access',
      "can't access",
      'private to you',
    ]) {
      expect(d).not.toContain(forbidden);
    }
  });
});

describe('visibilityOptionsFor — the review ceiling, surfaced', () => {
  it('offers every level on an APPROVED listing', () => {
    const opts = visibilityOptionsFor('approved');
    expect(opts.map((o) => o.value)).toEqual([...APP_LISTING_VISIBILITIES]);
    expect(opts.every((o) => o.enabled)).toBe(true);
    expect(opts.every((o) => o.disabledReason === undefined)).toBe(true);
  });

  it('🔴 caps an UNREVIEWED listing at `moderators`, and says WHY (D7)', () => {
    // 🔴 THE CEILING IS A DELIBERATE NARROWING OF D2, so a greyed option with no reason
    // reads as a bug. Driven at BOTH unreviewed statuses — a mutant keying on `draft`
    // alone passes a `draft`-only assertion.
    for (const status of ['draft', 'pending']) {
      const opts = visibilityOptionsFor(status);
      const enabled = opts.filter((o) => o.enabled).map((o) => o.value);
      expect(enabled).toEqual(['private', 'moderators']);
      for (const blocked of opts.filter((o) => !o.enabled)) {
        expect(blocked.value === 'testers' || blocked.value === 'public').toBe(true);
        expect(blocked.disabledReason).toBeTruthy();
        expect(blocked.disabledReason?.toLowerCase()).toContain('approved');
      }
    }
  });

  it('[INV] disables EVERY option on a status where no level may be set, without emptying the list', () => {
    // ⚠️ AN INVARIANT GUARD, NOT COVERAGE OF A REACHABLE PATH — labelled so nobody counts it
    // as the latter. Both call sites are gated on exactly `ceiling !== null`, so no surface
    // can reach this branch; it pins only that the function stays TOTAL. The reachability
    // claim this case used to carry ("the control must still be able to SHOW a current level
    // on a rejected/removed listing") was false and is retracted at the implementation.
    for (const status of INELIGIBLE) {
      const opts = visibilityOptionsFor(status);
      expect(opts).toHaveLength(APP_LISTING_VISIBILITIES.length);
      expect(opts.some((o) => o.enabled)).toBe(false);
      expect(opts.every((o) => Boolean(o.disabledReason))).toBe(true);
    }
  });

  it('never enables an option the SERVER ceiling would refuse — the agreement property', () => {
    // 🔴 THE SEAM, NOT A RESTATEMENT. This asserts the client's enablement is exactly the
    // server's `maxVisibilityForStatus` relation, over every status × level pair, so the
    // two cannot drift. Without it the options table would be pinning itself.
    for (const status of [...ELIGIBLE, ...INELIGIBLE]) {
      const ceiling = maxVisibilityForStatus(status);
      for (const o of visibilityOptionsFor(status)) {
        const serverWouldAllow =
          ceiling !== null &&
          APP_LISTING_VISIBILITIES.indexOf(o.value) <= APP_LISTING_VISIBILITIES.indexOf(ceiling);
        expect(o.enabled).toBe(serverWouldAllow);
      }
    }
  });
});

describe('visibilityCeilingReason', () => {
  it('is null where there is no ceiling to explain, and set where there is', () => {
    expect(visibilityCeilingReason('approved')).toBeNull();
    for (const status of INELIGIBLE) expect(visibilityCeilingReason(status)).toBeNull();
    for (const status of ['draft', 'pending']) {
      expect(visibilityCeilingReason(status)).toBeTruthy();
    }
  });
});

describe('visibilitySummaryLabel — 🔴 `null` is NOT `private`', () => {
  it('renders an unset level as its own state, never as Private', () => {
    // 🔴 THE THREE-STATES RULE REACHING THE UI. An unset level resolves to the pre-feature
    // rule — for an approved listing that is *visible to everyone*, the OPPOSITE of
    // `private`. Preselecting Private here would show every pre-existing owner a value they
    // never chose, and one save would hide their live app.
    expect(visibilitySummaryLabel(null, 'approved')).not.toBe(visibilityLevelLabel('private'));
    expect(visibilitySummaryLabel(null, 'approved').toLowerCase()).toContain('everyone');
    expect(visibilitySummaryLabel(null, 'draft').toLowerCase()).toContain('not set');
  });

  it('renders a set level as that level', () => {
    for (const level of APP_LISTING_VISIBILITIES) {
      expect(visibilitySummaryLabel(level, 'approved')).toBe(visibilityLevelLabel(level));
    }
  });
});

describe('visibilityPostApprovalPrompt — finding F11', () => {
  it('🔴 warns when a NARROWER level survived approval', () => {
    // The trap: nothing clears the column at approval, so an app approved at `moderators`
    // goes live visible to moderators only and the owner's only clue is that nobody uses
    // it. Both narrower-than-public levels must warn.
    for (const level of ['private', 'moderators', 'testers'] as const) {
      const msg = visibilityPostApprovalPrompt(level, 'approved');
      expect(msg).toBeTruthy();
      expect(msg).toContain(visibilityLevelLabel(level));
    }
  });

  it('stays silent for `public`, for an UNSET level, and on every non-approved status', () => {
    // 🔴 THE FOUR NEGATIVE ARMS, because a prompt that always fires is noise that gets
    // dismissed — and `null` is the common case for every pre-existing listing, so a
    // warning there would fire on essentially the whole corpus.
    expect(visibilityPostApprovalPrompt('public', 'approved')).toBeNull();
    expect(visibilityPostApprovalPrompt(null, 'approved')).toBeNull();
    for (const status of ['draft', 'pending', ...INELIGIBLE]) {
      expect(visibilityPostApprovalPrompt('moderators', status)).toBeNull();
    }
  });
});
