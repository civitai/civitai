import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * CALLER LEDGER — every production call site of `editorTabsFor` passes `lastModerationAction`.
 *
 * ## Why this file exists, and what it is NOT
 *
 * 🔴 THE PRIMARY ENFORCEMENT IS THE TYPE, NOT THIS TEST. `EditorTabContext.lastModerationAction`
 * is REQUIRED (`string | null`), so omitting it at a call site is a compile error, and
 * `tekton / typecheck` runs on every PR. If you are here because you added a caller and this
 * went red, the compiler almost certainly told you first.
 *
 * 🔴 SO WHAT DOES THIS ADD? Exactly the cases the compiler structurally cannot see:
 *
 *   - `tsconfig.json` excludes `src/**` + `/__tests__/**` from the program, so a call site in a
 *     `__tests__/` directory is NEVER typechecked. Measured on this tree with
 *     `tsc -p tsconfig.json --listFilesOnly`: `appListingEditorTabs.test.ts` appears 0 times.
 *   - a caller that launders the argument past the checker — `as any`, `as EditorTabContext`,
 *     a spread of a wider object, or a `.js`/untyped module.
 *   - a caller added in a NEW FILE nobody thought to look at, which is the case the ledger
 *     below is really for: it fails when the caller set GROWS as well as when a caller drops
 *     the field.
 *
 * ## The defect this is the guard for
 *
 * `lastModerationAction` was OPTIONAL for one release. In that window there were two
 * production callers and only one passed it: `myAppListingHref` (`myAppsView.ts`) dropped it,
 * even though the row it receives carries the field (`MyAppsBody` renders a badge off
 * `row.lastModerationAction` at the same call site). Result: two different tab sets derived for
 * ONE listing — the authoring page offered the owner `details`/`media` on their own
 * unpublished app, while the `/apps/mine` row linked at `?tab=publishing`. Nothing went red,
 * because optionality is precisely what makes a dropped field type-check.
 *
 * That is also mutant M8 of this PR's battery ("delete the `lastModerationAction:` line")
 * living unguarded at a second call site — the browser suite built to kill M8 covered one
 * caller of two.
 *
 * ## Reading discipline
 *
 * 🔴 COMMENTS ARE STRIPPED BEFORE ANY PROXIMITY TEST. Without that, this file's own prose —
 * which names both `editorTabsFor` and `lastModerationAction` many times — would satisfy the
 * guard, and so would the long doc comment above every real call site. A guard that its own
 * documentation can satisfy is worse than none: it reads as coverage while providing none.
 *
 * 🔴 THE POSITIVE CONTROL IS NOT OPTIONAL. A scan that resolves the wrong root, or whose
 * extension filter is wrong, finds zero call sites and passes every "all callers pass the
 * field" assertion vacuously. `it('positive control …')` asserts the sweep visited a
 * non-trivial number of files AND found a non-zero number of call sites, so a reassuring green
 * here cannot be a probe wired to nothing.
 */

/** Repo root, resolved from THIS file rather than from `process.cwd()`. */
const REPO_ROOT = resolve(__dirname, '../../../..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * 🔴 THE LEDGER. Every PRODUCTION file that calls `editorTabsFor`, repo-root-relative.
 *
 * Asserted as a SET, so it fails in BOTH directions:
 *   - a caller REMOVED  → the set shrank, and the ledger's claim to be complete is stale;
 *   - a caller ADDED    → the set grew, and nobody has checked the new one passes the field
 *     for the right reason (it must read the LISTING's own last moderation action, not a
 *     hardcoded `null` bolted on to silence the compiler).
 *
 * Growing this list is a deliberate act. When you add an entry, say in the PR why the new
 * caller's value is the listing's real one.
 */
const EXPECTED_CALLER_FILES = [
  'src/components/Apps/myAppsView.ts',
  'src/pages/apps/listing/[appListingId]/edit.tsx',
] as const;

/**
 * Strip `//` line comments and block comments, leaving string/template literals intact.
 *
 * A small state machine rather than a regex, because a regex cannot tell a `//` inside a
 * string (`'https://…'`, and this repo has many) from a real comment — and stripping the
 * remainder of such a line would silently delete real code, which fails OPEN (the argument
 * object would look empty and the guard would report a missing field that is present).
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    // Line comment
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // String / template literal — copied through verbatim, escapes honoured.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every `.ts`/`.tsx` file under `src/`, excluding test files and `__tests__/` dirs. */
function productionSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      productionSourceFiles(full, acc);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    // `.test.ts`, `.test.tsx`, `.browser.test.tsx`, `.spec.ts` — not production.
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    acc.push(full);
  }
  return acc;
}

/**
 * Extract the source text of each `editorTabsFor(...)` argument list in `code`, by
 * BRACKET-MATCHING from the opening paren rather than by regex — the argument is a
 * multi-line object literal containing nested braces, which no regex handles.
 */
function editorTabsForCallArgs(code: string): string[] {
  const calls: string[] = [];
  const needle = 'editorTabsFor(';
  let from = 0;
  for (;;) {
    const at = code.indexOf(needle, from);
    if (at === -1) break;
    // Skip an identifier match that is part of a longer name (e.g. `myEditorTabsForX`).
    const before = at > 0 ? code[at - 1] : ' ';
    if (/[A-Za-z0-9_$]/.test(before)) {
      from = at + needle.length;
      continue;
    }
    // 🔴 SKIP THE DECLARATION SITE. `export function editorTabsFor(ctx: EditorTabContext)`
    // matches the same needle as a call, so without this the defining module reports itself
    // as a caller whose "argument list" is a PARAMETER list — which of course does not
    // contain `lastModerationAction`. That is a false POSITIVE (a spurious red), and it was
    // caught on this guard's first run, which is the outcome a negative control is for.
    // Keyed on the preceding `function` keyword rather than on the file path, so the
    // definition can move without silently un-skipping.
    if (/\bfunction\s*$/.test(code.slice(Math.max(0, at - 24), at))) {
      from = at + needle.length;
      continue;
    }
    let depth = 0;
    let i = at + needle.length - 1; // at the '('
    const start = i + 1;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(code.slice(start, i));
    from = i;
  }
  return calls;
}

const scanned = productionSourceFiles(SRC_ROOT).map((path) => {
  const stripped = stripComments(readFileSync(path, 'utf8'));
  return {
    path,
    rel: relative(REPO_ROOT, path).split('\\').join('/'),
    calls: editorTabsForCallArgs(stripped),
  };
});
const callerFiles = scanned.filter((f) => f.calls.length > 0);

describe('editorTabsFor — the CALLER LEDGER', () => {
  /**
   * 🔴 POSITIVE CONTROL. Everything below is of the form "for each caller found, assert X".
   * With zero callers found — a wrong root, a wrong extension filter, a comment stripper that
   * ate the file — all of them pass vacuously and this suite reports a confident, meaningless
   * green. These two numbers are what make the green mean something.
   */
  it('positive control — the sweep actually read the tree and found call sites', () => {
    // A floor, not the exact count: `src/` has thousands of files and this must not become a
    // tripwire that reddens whenever someone adds an unrelated component.
    expect(scanned.length).toBeGreaterThan(500);
    expect(callerFiles.length).toBeGreaterThan(0);
    expect(callerFiles.reduce((n, f) => n + f.calls.length, 0)).toBeGreaterThan(0);
  });

  /**
   * 🔴 NEGATIVE CONTROL FOR THE COMMENT STRIPPER, and it is the load-bearing one.
   *
   * The proximity test below asks "does the argument text contain `lastModerationAction`". If
   * comments survived stripping, a call site whose DOC COMMENT names the field would pass
   * while the code omitted it — which is exactly the shape of the defect being guarded (every
   * real call site here carries a long comment that names the field repeatedly). This asserts
   * the stripper removes both comment forms and, critically, does NOT damage a string that
   * merely looks like one.
   */
  it('the comment stripper removes comments and preserves strings', () => {
    expect(stripComments('a // lastModerationAction\nb')).not.toMatch(/lastModerationAction/);
    expect(stripComments('a /* lastModerationAction */ b')).not.toMatch(/lastModerationAction/);
    // A `//` inside a string is NOT a comment — eating it would delete real code and make
    // this guard fail open.
    expect(stripComments(`const u = 'https://x/y'; const k = lastModerationAction;`)).toMatch(
      /lastModerationAction/
    );
    expect(stripComments(`const u = 'https://x/y';`)).toMatch(/https:\/\/x\/y/);
  });

  /**
   * 🔴 THE SET, PINNED IN BOTH DIRECTIONS. `toEqual` on a sorted array fails when the caller
   * set SHRINKS (a caller was deleted and this ledger's completeness claim went stale) and
   * when it GROWS (a new caller nobody has vetted). The seam this file guards is a
   * RELATIONSHIP — "every caller agrees on the inputs" — and a relationship can only be
   * pinned by enumerating the whole population, never by checking one member.
   */
  it('🔴 the set of production callers is EXACTLY the ledger — fails if it grows OR shrinks', () => {
    expect(callerFiles.map((f) => f.rel).sort()).toEqual([...EXPECTED_CALLER_FILES].sort());
  });

  /**
   * 🔴 THE ACTUAL SEAM ASSERTION. Every call site passes the field, checked against
   * COMMENT-STRIPPED source so neither the surrounding doc comment nor this file's own prose
   * can satisfy it.
   */
  it('🔴 EVERY production call site passes `lastModerationAction`', () => {
    const offenders: string[] = [];
    for (const file of callerFiles) {
      file.calls.forEach((args, idx) => {
        if (!/\blastModerationAction\b/.test(args)) {
          offenders.push(`${file.rel} (call #${idx + 1})`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The field must be WIRED, not silenced. `lastModerationAction: null` written as a literal
   * at a call site that HAS the real value available is how a required field gets defeated
   * while still type-checking — the compiler is satisfied and the behaviour is the old bug.
   *
   * 🟡 LABEL: this is an INVARIANT GUARD, not regression coverage. Neither of today's callers
   * ever passed a literal `null`, so this pins a property the bug never violated. It is here
   * because it is the cheapest next failure mode once the field is required, and because the
   * fix direction for a compile error is genuinely tempting to get wrong.
   */
  it('🟡 invariant — no call site silences the requirement with a literal `null`', () => {
    const silenced: string[] = [];
    for (const file of callerFiles) {
      file.calls.forEach((args, idx) => {
        if (/\blastModerationAction\s*:\s*null\b/.test(args)) {
          silenced.push(`${file.rel} (call #${idx + 1})`);
        }
      });
    }
    expect(silenced).toEqual([]);
  });
});
