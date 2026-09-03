import { describe, expect, it } from 'vitest';
import {
  RESTRICTION_TYPE,
  RESTRICTION_TYPES,
  RESTRICTION_TYPE_LABELS,
  RULINGS_WIRED_FOR,
  unwiredRulingReason,
} from '$lib/restriction-types';

/**
 * The one predicate three surfaces read: the audit queue's `resolve`/`ban` refusal, the audit queue's
 * disabled ruling buttons, and the retool User Lookup panel's disabled ruling form. It was open-coded
 * in the route before #4609's audit; a predicate spelled at N sites is wrong at N−1 of them, and here
 * the sites disagreeing means a live button whose only possible outcome is a rejected call.
 *
 * The refusal that MATTERS is enforced by the main app, inside `resolveUserRestriction` — this list is
 * the same rule read forward so a form that cannot succeed is never offered. The two are pinned to
 * each other by `src/server/services/__tests__/restriction-type-seam.test.ts`.
 */
describe('unwiredRulingReason', () => {
  it('permits a ruling on every wired-for type', () => {
    // Non-vacuous: there is at least one, and it is the queue's default.
    expect(RULINGS_WIRED_FOR.length).toBeGreaterThan(0);
    expect(RULINGS_WIRED_FOR).toContain(RESTRICTION_TYPE);
    for (const type of RULINGS_WIRED_FOR) expect(unwiredRulingReason(type)).toBeNull();
  });

  it('refuses every filed type that has no verdict path, naming it', () => {
    const unwired = RESTRICTION_TYPES.filter((t) => !RULINGS_WIRED_FOR.includes(t));
    // The guard is only worth anything while some type is refused; today that is `bot-account`.
    expect(unwired.length).toBeGreaterThan(0);

    for (const type of unwired) {
      const reason = unwiredRulingReason(type);
      // The type is named because a moderator has to be able to tell WHICH queue is review-only, and
      // the message doubles as the audit route's `fail(400)` body.
      expect(reason).toContain(`"${type}"`);
      expect(reason).toContain('NOT resolved');
    }
  });

  it('refuses a type nobody has heard of, rather than defaulting it in', () => {
    // The value reaching this can come off a database row, so it is not confined to the union.
    for (const type of ['', 'GENERATION', 'generation ', 'nonsense'])
      expect(unwiredRulingReason(type)).not.toBeNull();
  });

  it('keeps a label for every filed type, so a refused queue can still be named on screen', () => {
    expect(Object.keys(RESTRICTION_TYPE_LABELS).sort()).toEqual([...RESTRICTION_TYPES].sort());
  });
});
