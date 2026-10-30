import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { stripCommentsAndStrings } from './strip-comments';

/**
 * The shared repo-walk behind the `*.call-site-ledger.test.ts` family.
 *
 * 🔴 WHY THIS IS A SHARED MODULE RATHER THAN A TECHNIQUE COPIED A FIFTH TIME — the same
 * argument `strip-comments.ts` makes one level down, and the reason it exists at all.
 * `walk` / `sourceFiles` / `callersOf` were byte-identical across
 * `private-run-access.call-site-ledger`, `app-access.call-site-ledger`,
 * `dev-scoped-mint.call-site-ledger` and `mint-audit-stdout.call-site-ledger`, and a new
 * ledger made five. That duplication is not cosmetic, because of what the duplicated
 * thing IS:
 *
 * 🔴 `EXCLUDE_TEST_FILES` IS THE DEFINITION OF THE SCANNED POPULATION, and every one of
 * those ledgers asserts ENUMERATED EQUALITY against it. So a sixth test-directory
 * convention (or a `.mts`/`.cts` file) fixed in one copy leaves the others silently
 * scanning a different corpus — and a SHRUNK population turns a ledger GREEN while the
 * call site it stopped seeing goes unguarded. A vacuous pass, arrived at by a change in
 * a different file. One module, all callers.
 *
 * This lives under `test/` rather than `src/test-utils/` deliberately: `sourceFiles()`
 * walks `src/`, so a helper inside `src/` would be a member of the population it defines.
 * `src/test-utils/routerSourceRegions.ts` is a different tool — per-source region work
 * (`callSites`, `enclosingDecl`) rather than a repo-wide walk — and is not a substitute.
 *
 * Each caller still carries its OWN positive/negative controls. Sharing the walk does not
 * share the obligation to prove it enumerated something.
 *
 * 🔴 THE WALK IS SHARED; THE STRIPPER IS A SEPARATE CHOICE. These ledgers disagree about
 * string literals, and both answers are right: a call site is never inside a string, but
 * `mint-audit-stdout` MATCHES QUOTED EVENT NAMES and would detect nothing if they were
 * stripped. So `scanSource` bundles the walk with `stripCommentsAndStrings`; a caller that
 * needs comments-only imports `sourceFiles` here and `stripComments` from
 * `./strip-comments` — which exists for exactly that case. Do not push every ledger
 * through `scanSource`, and do not read that as "each must hand-roll its own".
 *
 * ⚠️ NOT ADOPTED BY `block-token-access.call-site-ledger.test.ts`, which carries a walk that
 * omits the `.test.tsx?$` and `src/tests/` exclusions entirely — so its population already
 * differs from every file here. Converting it would CHANGE its ledger rather than preserve
 * it (it discriminates by import, and test files are currently inside its corpus), so that
 * is a decision with a result to re-check, not a mechanical move.
 */

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

/**
 * Test files, excluded from every ledger's population.
 *
 * Kept as ONE exported pattern so the three conventions it covers — a `__tests__`
 * directory, a `*.test.ts(x)` filename, and the `src/tests/` tree — cannot be fixed in
 * one ledger and missed in another.
 */
export const EXCLUDE_TEST_FILES = /__tests__|\.test\.tsx?$|(^|\/)src\/tests\//;

/**
 * Every `.ts`/`.tsx` file under `dir`, recursively, as absolute paths.
 *
 * 🔴 `statSync`, NOT `readdirSync(..., { withFileTypes: true })`. `withFileTypes` reports a
 * SYMLINK as neither a file nor a directory, so a symlinked source dir is silently skipped —
 * exactly the narrowing a population definition must never do. `statSync` follows the link.
 * A sibling guard has already had to fix this once in its own copy.
 */
export function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every NON-TEST `.ts`/`.tsx` under `<root>/src`, as repo-relative POSIX-ish paths. */
export function sourceFiles(root: string): string[] {
  return walk(join(root, 'src'))
    .map((f) => relative(root, f).split(sep).join('/'))
    .filter((f) => !EXCLUDE_TEST_FILES.test(f));
}

export type SourceScan = {
  /** The scanned population, repo-relative. */
  files: string[];
  /** Per-file source with comments AND string literals stripped — prose cannot match. */
  code: Map<string, string>;
  /** Raw file text, for assertions about literals (which `code` has stripped). */
  raw(file: string): string;
  /**
   * Files whose CODE calls `name(`, excluding the file `definedIn` names as its home.
   *
   * The home map is HAND-WRITTEN by each caller rather than inferred: `/function <name>/`
   * cannot see a `static async` class method, and inferring "where is this defined" with
   * a pattern that can be wrong is how a defining file gets counted as a caller.
   */
  callersOf(name: string): string[];
};

/**
 * Build a scan of `<root>/src`, with `definedIn` mapping symbol → its defining file.
 *
 * ⚠️ `definedIn` is OPTIONAL because callers that only need `files`/`code` should not have
 * to invent one — but a caller that uses `callersOf` and omits it gets the DEFINING file
 * counted as a caller, silently and with no type error. If you call `callersOf`, pass the
 * map.
 */
export function scanSource(root: string, definedIn: Record<string, string> = {}): SourceScan {
  const files = sourceFiles(root);
  const code = new Map(
    files.map((f) => [f, stripCommentsAndStrings(readFileSync(join(root, f), 'utf8'))] as const)
  );
  return {
    files,
    code,
    raw: (file: string) => readFileSync(join(root, file), 'utf8'),
    callersOf(name: string) {
      const re = new RegExp(`\\b${name}\\s*\\(`);
      const home = definedIn[name];
      return files.filter((f) => re.test(code.get(f)!) && f !== home).sort();
    },
  };
}
