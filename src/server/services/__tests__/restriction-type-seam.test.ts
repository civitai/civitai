import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PENDING_REVIEW_MUTE_NOTIFICATION,
  RULINGS_WIRED_FOR,
  USER_RESTRICTION_TYPES,
  unwiredRulingReason,
} from '~/server/services/user-restriction.service';

/**
 * The seam between the three things that have to agree about a restriction type, none of which imports
 * the others at runtime:
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

const repoRoot = path.resolve(__dirname, '../../../..');

/**
 * The moderator app's vocabulary file, read as TEXT rather than imported: it is a separate SvelteKit
 * project with its own `$lib` aliasing and its own Vitest project, so the main app's suite cannot
 * resolve its modules.
 *
 * Every parse below is deliberately narrow — it takes one literal and fails loudly if the declaration
 * is not where it says it is, so a moved or renamed constant reports as a broken guard rather than
 * silently matching nothing and passing.
 */
const MODERATOR_TYPES_FILE = path.join(repoRoot, 'apps/moderator/src/lib/restriction-types.ts');

function moderatorSource(): string {
  return readFileSync(MODERATOR_TYPES_FILE, 'utf-8');
}

/** The single-quoted strings inside the array literal a declaration assigns. */
function moderatorArray(declaration: RegExp, name: string): string[] {
  const match = declaration.exec(moderatorSource());
  if (!match) {
    throw new Error(
      `Could not find a \`${name}\` array literal in ${MODERATOR_TYPES_FILE}. If it moved, update this guard — do not delete it.`
    );
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The moderator app's copy of the types that can be FILED and reviewed. */
function moderatorRestrictionTypes(): string[] {
  return moderatorArray(
    /export const RESTRICTION_TYPES = \[([^\]]*)\] as const;/,
    'RESTRICTION_TYPES'
  );
}

/** The moderator app's copy of the types a VERDICT may be handed to. */
function moderatorRulingsWiredFor(): string[] {
  return moderatorArray(/export const RULINGS_WIRED_FOR[^=]*=\s*\[([^\]]*)\]/, 'RULINGS_WIRED_FOR');
}

/**
 * The moderator app's refusal message, with `${type}` substituted — read out of its template literal.
 *
 * The list is the rule; this is the sentence a moderator reads. They are pinned separately because
 * they fail differently: a drifted LIST is a security hole, a drifted SENTENCE is two surfaces
 * explaining the same refusal in two ways.
 */
function moderatorUnwiredRulingMessage(type: string): string {
  const match = /return \(RULINGS_WIRED_FOR[\s\S]*?: `([^`]+)`;/.exec(moderatorSource());
  if (!match) {
    throw new Error(
      `Could not find the \`unwiredRulingReason\` message template in ${MODERATOR_TYPES_FILE}. If it moved, update this guard — do not delete it.`
    );
  }
  return match[1].replaceAll('${type}', type);
}

describe('restriction type — main app ⇄ moderator app', () => {
  // A positive control on the parser itself. A regex that silently matched nothing would make the
  // equality assertion below compare two empty-ish things and pass with the guard providing nothing.
  it('reads a non-empty type list out of the moderator app', () => {
    expect(moderatorRestrictionTypes().length).toBeGreaterThan(0);
    expect(moderatorRestrictionTypes()).toContain('generation');
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
    expect([...moderatorRestrictionTypes()].sort()).toEqual([...USER_RESTRICTION_TYPES].sort());
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
    // Positive control on this file's second parser, for the same reason the first one has one: a
    // regex that silently matched nothing would compare two empty things and pass.
    expect(moderatorRulingsWiredFor().length).toBeGreaterThan(0);
    expect(moderatorRulingsWiredFor()).toContain('generation');
  });

  it('agrees with the main app about which types a verdict can be handed to', () => {
    expect([...moderatorRulingsWiredFor()].sort()).toEqual([...RULINGS_WIRED_FOR].sort());
  });

  it('refuses the same types on both sides, word for word', () => {
    // Every type that can be FILED, so a type added to the vocabulary without a verdict path is
    // covered here the day it is added rather than the day someone remembers this file.
    for (const type of USER_RESTRICTION_TYPES) {
      const main = unwiredRulingReason(type);
      const moderator = moderatorRulingsWiredFor().includes(type)
        ? null
        : moderatorUnwiredRulingMessage(type);
      expect(moderator).toEqual(main);
    }
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
