import fs from 'node:fs';
import path from 'node:path';

/**
 * How the main app's suite reads the moderator app's restriction vocabulary: it **imports and
 * executes** the module and reads the resulting VALUES — plus one TEXT assertion, because the two
 * mechanisms are blind to different things (see `assertEnvironmentIndependent` below).
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
 * 🔴 CROSS-APP BUILD COUPLING, and it lands on the MAIN app's suite. Resolving that path makes Vite
 * load `apps/moderator/tsconfig.json`, which extends the generated, gitignored
 * `apps/moderator/.svelte-kit/tsconfig.json` — so without `svelte-kit sync` having been run in
 * `apps/moderator`, this file and `restriction-type-seam.test.ts` both fail with
 * `TSConfckParseError: failed to resolve "extends"`, an error naming a tsconfig rather than the
 * seam. CI is unaffected (`prepare` runs sync); a fresh clone or a fresh worktree is not.
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

/**
 * 🔴 The blind spot the execute-based reader has and the text parser it replaced did NOT, so this
 * check is COMPLEMENTARY to `readModeratorVocabulary` rather than a leftover of it — keep both.
 *
 * Executing the module reads its values **in the main app's test process**. An environment-dependent
 * value is therefore resolved under Vitest's environment, not under the moderator app's production
 * build. Measured on #4609, writing the list as
 *
 *     export const RULINGS_WIRED_FOR: readonly RestrictionType[] = import.meta.env.DEV
 *       ? ['generation']
 *       : ['generation', 'bot-account'];
 *
 * left the seam and vocabulary suites at 28 passed / 0 failed and the moderator app's own value pin
 * at 5 passed / 0 failed, while the production build shipped both types — the ban-then-strand hazard
 * reached with every pinning guard green. The base commit's text parser went RED on that same shape,
 * so the execute reader is not strictly stronger; it trades a formatting blind spot for a
 * runtime-environment one.
 *
 * 🔴 SCOPE — this refuses the two spellings below and NOT the class. It is a text scan, so it is
 * walkable by indirection, and that was measured on #4609: an aliased global
 * (`const P = (globalThis as any).process` then `P?.env`), a computed member access
 * (`P['env']['NODE_ENV']`), and a regex literal containing `//` placed on the SAME line as the read
 * — which `withoutComments` below truncates as a line comment — each left the seam and vocabulary
 * suites at 29 passed / 0 failed while the two apps genuinely disagreed. Every spelling a maintainer
 * would plausibly reach for IS covered: `import.meta.*` and `process.env.*` are caught here, and
 * `import { dev } from '$app/environment'` or `$env/*` break loudly as a missing module. Do not read
 * this as closing the environment-read class.
 *
 * 🔴 Note what this means for the "keep this module import-free" precondition: `import.meta.env` and
 * `process.env` need NO import statement, so import-freedom does not imply environment-independence.
 * They are two separate constraints and this asserts the second one.
 */
const ENVIRONMENT_READ = /import\.meta|process\.env/;

/**
 * 🔴 Comments are removed before the scan, and that is not a nicety — without it the guard is
 * matched by its OWN documentation. The module it checks has to be able to say, in prose, which
 * shapes are refused; a raw-text scan then fires on the sentence forbidding the thing rather than on
 * the thing, and the only way to keep the suite green is to stop documenting the rule.
 *
 * String literals are deliberately KEPT: a `//` inside one must not start a comment, and an
 * environment read cannot hide inside a string anyway — a string is not executable.
 */
function withoutComments(sourceText: string): string {
  let out = '';
  let i = 0;
  while (i < sourceText.length) {
    const c = sourceText[i];
    const next = sourceText[i + 1];
    if (c === '/' && next === '/') {
      while (i < sourceText.length && sourceText[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < sourceText.length && !(sourceText[i] === '*' && sourceText[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < sourceText.length && sourceText[i] !== quote) {
        if (sourceText[i] === '\\') {
          out += sourceText[i];
          i++;
        }
        out += sourceText[i];
        i++;
      }
      out += sourceText[i] ?? '';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 🔴 Comments are stripped before the scan, string literals are NOT — deliberately, since a string
 * can be interpolated into a read. The cost is that the scanned module may not MENTION these tokens
 * in a string either: `export const HINT = 'never read process.env here'` trips this guard. That
 * fails SAFE — red with this message, never silently green — but it is a real constraint on the
 * module, and a mention in a COMMENT is the supported way to write one.
 */
export function assertEnvironmentIndependent(sourceText: string, source: string): void {
  const found = ENVIRONMENT_READ.exec(withoutComments(sourceText));
  if (found)
    throw new Error(
      `${source} reads \`${found[0]}\`. The vocabulary must be the SAME VALUES in every environment: this guard executes the module in the main app's test process, so an environment-conditional list is read under Vitest and never under the moderator app's production build — the two apps could then ship different lists with every guard green. Write the list as constants, not as a branch on the environment.`
    );
}

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
  const source = file === MODERATOR_VOCABULARY_PATH ? MODERATOR_VOCABULARY_FILE : file;
  // The TEXT half, run BEFORE the import so the failure names the constraint rather than reporting a
  // list that happens to be correct in this process. See `assertEnvironmentIndependent`.
  assertEnvironmentIndependent(fs.readFileSync(file, 'utf-8'), source);
  // `@vite-ignore` because the path is computed: this reader is deliberately usable against a
  // fixture, which is the only way to test that it sees a divergence at all.
  const mod = await import(/* @vite-ignore */ file);
  return asModeratorVocabulary(mod, source);
}
