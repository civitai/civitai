import path from 'node:path';

/**
 * How the main app's suite reads the moderator app's restriction vocabulary: it **imports and
 * executes** the module and reads the resulting VALUES.
 *
 * 🔴 It used to parse the file as TEXT with a pair of regexes, and that was walkable. `[^\]]*`
 * stops at the FIRST `]` after the `=`, so a `]` anywhere inside the literal — in a trailing
 * comment, in an index expression — truncated the capture, and the extractor only ever read
 * SINGLE-quoted strings, so a double-quoted entry vanished. Measured on #4609: writing the
 * moderator list as
 *
 *     export const RULINGS_WIRED_FOR: readonly RestrictionType[] = [
 *       'generation', // matches RESTRICTION_TYPES[0]
 *       'bot-account',
 *     ];
 *
 * left the seam suite at 8 passed / 0 failed while the two lists genuinely disagreed. The
 * `length > 0` positive control could not see it either — the first entry survives the truncation.
 *
 * 🔴 Widening the regex would only move the goalposts: a guard that pins source text by PATTERN is
 * walkable by rewriting the text, and the rewrite that walks it is not a hostile act — it is
 * someone running Prettier or adding a comment. Executing the module removes the whole class:
 * formatting, quote style, trailing commas, comments, `as const`, a spread, a value assembled at
 * runtime and a re-export all produce the same values, because they ARE the same values.
 *
 * Why this is possible at all: `apps/moderator/src/lib/restriction-types.ts` has **no imports**.
 * That is what lets a main-app Vitest project load it despite the moderator app being a separate
 * SvelteKit build with its own `$lib` aliasing. If someone gives that file a `$lib/…` import this
 * stops resolving — and it stops LOUDLY, with a module-not-found naming the file, which is the
 * correct outcome: the two apps would then no longer share a plain-data vocabulary module and the
 * mirror needs re-deciding rather than silently relaxing.
 *
 * Not typechecked (`src/**\/__tests__/**` is excluded in tsconfig.json), so the shape is validated
 * at runtime by `asModeratorVocabulary` below rather than by the compiler.
 */

/** Repo-root-relative, for error messages. */
export const MODERATOR_VOCABULARY_FILE = 'apps/moderator/src/lib/restriction-types.ts';

export const MODERATOR_VOCABULARY_PATH = path.resolve(
  __dirname,
  '../../../..',
  MODERATOR_VOCABULARY_FILE
);

export type ModeratorRestrictionVocabulary = {
  /** The moderator app's copy of the types that can be FILED and reviewed. */
  restrictionTypes: readonly string[];
  /** The moderator app's copy of the types a VERDICT may be handed to. */
  rulingsWiredFor: readonly string[];
  /** The moderator app's refusal message, executed rather than read out of its template literal. */
  unwiredRulingReason: (type: string) => string | null;
};

function stringArray(value: unknown, name: string, source: string): readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw new Error(
      `\`${name}\` in ${source} is not an array of strings. If the vocabulary moved or changed shape, update this guard — do not delete it.`
    );
  // A non-empty list is the positive control the old text parse needed a separate test for: an
  // empty one would make every comparison below compare two empty-ish things and pass.
  if (value.length === 0)
    throw new Error(
      `\`${name}\` in ${source} is empty. That cannot be right, and an empty list would make every comparison against it vacuous.`
    );
  return value as readonly string[];
}

/**
 * Validates the shape of an imported vocabulary module and projects it. Throws — loudly, naming the
 * file — rather than returning something empty, so a renamed or removed export reports as a broken
 * guard instead of silently matching nothing.
 */
export function asModeratorVocabulary(
  mod: unknown,
  source: string
): ModeratorRestrictionVocabulary {
  const m = (mod ?? {}) as Record<string, unknown>;
  // Order matters only for the error you get back: the lists are checked first so a module that is
  // missing everything reports the first thing it is missing rather than the last.
  const restrictionTypes = stringArray(m.RESTRICTION_TYPES, 'RESTRICTION_TYPES', source);
  const rulingsWiredFor = stringArray(m.RULINGS_WIRED_FOR, 'RULINGS_WIRED_FOR', source);
  if (typeof m.unwiredRulingReason !== 'function')
    throw new Error(
      `\`unwiredRulingReason\` in ${source} is not a function. If it moved, update this guard — do not delete it.`
    );
  return {
    restrictionTypes,
    rulingsWiredFor,
    unwiredRulingReason: m.unwiredRulingReason as (type: string) => string | null,
  };
}

/**
 * Import-and-execute. `file` is defaulted to the real moderator module; the fixture suite passes
 * its own copies so the reader itself is under test, not only the pairing it happens to read today.
 */
export async function readModeratorVocabulary(
  file: string = MODERATOR_VOCABULARY_PATH
): Promise<ModeratorRestrictionVocabulary> {
  // `@vite-ignore` because the path is computed: this reader is deliberately usable against a
  // fixture, which is the only way to test that it sees a divergence at all.
  const mod = await import(/* @vite-ignore */ file);
  return asModeratorVocabulary(
    mod,
    file === MODERATOR_VOCABULARY_PATH ? MODERATOR_VOCABULARY_FILE : file
  );
}
