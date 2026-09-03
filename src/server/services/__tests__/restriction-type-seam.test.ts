import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PENDING_REVIEW_MUTE_NOTIFICATION,
  USER_RESTRICTION_TYPES,
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
 * Reads the `RESTRICTION_TYPES` array literal out of the moderator app's source.
 *
 * Read as TEXT rather than imported: the moderator app is a separate SvelteKit project with its own
 * `$lib` aliasing and its own Vitest project, so the main app's suite cannot resolve its modules. The
 * parse is deliberately narrow — it takes the array literal and fails loudly if the declaration is not
 * where it says it is, so a moved or renamed constant reports as a broken guard rather than silently
 * matching nothing and passing.
 */
function moderatorRestrictionTypes(): string[] {
  const file = path.join(repoRoot, 'apps/moderator/src/lib/restriction-types.ts');
  const source = readFileSync(file, 'utf-8');
  const match = /export const RESTRICTION_TYPES = \[([^\]]*)\] as const;/.exec(source);
  if (!match) {
    throw new Error(
      `Could not find a \`RESTRICTION_TYPES\` array literal in ${file}. If it moved, update this guard — do not delete it.`
    );
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
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
