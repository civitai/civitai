import { beforeAll, describe, expect, it } from 'vitest';
import {
  readModeratorVocabulary,
  type ModeratorRestrictionVocabulary,
} from './moderator-restriction-vocabulary.harness';
import {
  PENDING_REVIEW_MUTE_NOTIFICATION,
  RULINGS_WIRED_FOR,
  USER_RESTRICTION_TYPES,
  unwiredRulingReason,
} from '~/server/services/user-restriction.service';

/**
 * The seam between the three things that have to agree about a restriction type, none of which imports
 * the others in production (this file does, deliberately — see below):
 *
 *   1. the main app, which FILES restrictions of a type;
 *   2. the moderator app, which is the only place one can be REVIEWED;
 *   3. the notification registry, which decides whether the user is told anything intelligible.
 *
 * 🔴 Each of the three is separately covered by a suite that loads only its own surface, and that is
 * exactly why this file exists: a type can be filed by an app whose queue view cannot list it, or
 * mapped to a notification that nothing renders, without a single one of those suites going red. The
 * defect lives in the seam nobody owns.
 */

/**
 * 🔴 The moderator app's vocabulary is IMPORTED AND EXECUTED, not parsed. It used to be read as
 * TEXT, and that guard passed green over a real divergence: `/…= \[([^\]]*)\]/` stops at the first
 * `]` after the `=`, so a comment naming an index truncated the capture, and the extractor read only
 * single-quoted strings, so a double-quoted entry vanished. Measured on #4609 — this file reported
 * **8 passed / 0 failed** with the two lists genuinely disagreeing.
 *
 * A wider regex would not have fixed it. A guard that pins source text by PATTERN is walkable by
 * reformatting the text, and the reformattings that walk it are ordinary. Executing the module makes
 * formatting irrelevant by construction.
 *
 * That the import resolves at all rests on one fact: `apps/moderator/src/lib/restriction-types.ts`
 * has no imports of its own, so the main app's Vitest project can load it even though the moderator
 * app is a separate SvelteKit build with its own `$lib` aliasing. Give that file a `$lib/…` import
 * and this fails loudly, naming the module — which is the right outcome, not something to work
 * around.
 *
 * The reader, its shape validation and the fixtures that prove it sees a divergence live in
 * `src/server/services/__tests__/moderator-restriction-vocabulary.harness.ts` and
 * `src/server/services/__tests__/moderator-restriction-vocabulary.test.ts`.
 */
let moderator: ModeratorRestrictionVocabulary;

beforeAll(async () => {
  moderator = await readModeratorVocabulary();
});

describe('restriction type — main app ⇄ moderator app', () => {
  // A positive control on the reader. It cannot come back empty — `readModeratorVocabulary` throws
  // on an empty or unreadable list rather than returning one — but this pins the fact rather than
  // trusting a helper in another file to keep doing it.
  it('reads a non-empty type list out of the moderator app', () => {
    expect(moderator.restrictionTypes.length).toBeGreaterThan(0);
    expect(moderator.restrictionTypes).toContain('generation');
  });

  /**
   * 🔴 Fails when the sets DIFFER IN EITHER DIRECTION, which is the point — the two failure modes are
   * opposite and both silent:
   *
   *  - a type in the main app but not the moderator app files cases into a queue with no view, so a
   *    detector's findings are muted accounts nobody can ever see or clear;
   *  - a type in the moderator app but not the main app is a queue tab that can only ever be empty.
   */
  it('files exactly the types the moderator queue can show', () => {
    expect([...moderator.restrictionTypes].sort()).toEqual([...USER_RESTRICTION_TYPES].sort());
  });
});

/**
 * 🔴 The third thing that has to agree, added after the audit on #4609: WHICH types a verdict may be
 * handed to. That is enforced in the main app, inside `resolveUserRestriction`, because five callers
 * reach it and a guard replicated per route is wrong at all but one of them. The moderator app holds a
 * copy anyway, and needs to — a list read forward is what lets a form that cannot possibly succeed be
 * DISABLED rather than merely rejected, and what lets the audit queue refuse a ban BEFORE it bans
 * (that action bans and then rules, so a late refusal strands a Pending row on a banned account).
 *
 * Two separate builds with no runtime import path between them, so the copy is pinned here rather than
 * left to drift. A moderator app that thought `bot-account` was rulable would render live Uphold and
 * Ban buttons whose only possible outcome is a rejected call.
 */
describe('restriction type — ruling scope ⇄ moderator app', () => {
  it('reads a non-empty wired-for list out of the moderator app', () => {
    expect(moderator.rulingsWiredFor.length).toBeGreaterThan(0);
    expect(moderator.rulingsWiredFor).toContain('generation');
  });

  it('agrees with the main app about which types a verdict can be handed to', () => {
    expect([...moderator.rulingsWiredFor].sort()).toEqual([...RULINGS_WIRED_FOR].sort());
  });

  it('refuses the same types on both sides, word for word', () => {
    // Every type that can be FILED, so a type added to the vocabulary without a verdict path is
    // covered here the day it is added rather than the day someone remembers this file. The
    // moderator side is CALLED, not read out of its template literal — so a message assembled from
    // constants, or moved behind a helper, is compared on what it produces.
    for (const type of USER_RESTRICTION_TYPES)
      expect(moderator.unwiredRulingReason(type)).toEqual(unwiredRulingReason(type));

    // The whole comparison above is vacuous if no type is currently refused — assert one is.
    expect(USER_RESTRICTION_TYPES.some((t) => unwiredRulingReason(t) !== null)).toBe(true);
  });
});

describe('restriction type — notification mapping', () => {
  it('maps every restriction type, so a new one cannot default into someone else’s message', () => {
    expect(Object.keys(PENDING_REVIEW_MUTE_NOTIFICATION).sort()).toEqual(
      [...USER_RESTRICTION_TYPES].sort()
    );
  });

  /**
   * 🔴 The guard that makes `null` safe to rely on. `createNotification` validates `type` against
   * nothing — it is `z.string()` at the schema and `text` at the table, and the fan-out worker inserts
   * it verbatim — so an unregistered type is PERSISTED and increments the user's unread badge, while
   * the bell dropdown drops it at render because no processor can build a message for it. The result is
   * a phantom unread count with no click target, clearable only by "mark all read".
   *
   * So: any type this map names must be a registered processor key. Adding a mapping without adding
   * the processor fails here rather than shipping a ghost notification.
   */
  it('names only registered notification processors', async () => {
    const { notificationProcessors } = await import('~/server/notifications/utils.notifications');
    const registered = Object.keys(notificationProcessors);

    // Positive control: the registry actually loaded and holds the key the generation path uses. A
    // `registered` that came back empty would make the loop below vacuously true.
    expect(registered).toContain('generation-muted');

    const mapped = Object.values(PENDING_REVIEW_MUTE_NOTIFICATION).filter(
      (v): v is string => v !== null
    );
    expect(mapped.length).toBeGreaterThan(0);
    for (const type of mapped) expect(registered).toContain(type);
  });

  it('keeps generation on the message written for it', () => {
    // Pinned by value: silently repointing generation at another processor would change what every
    // muted user is told, and no other test in this repo reads the mapping.
    expect(PENDING_REVIEW_MUTE_NOTIFICATION.generation).toBe('generation-muted');
  });
});
