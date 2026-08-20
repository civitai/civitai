import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 NO SOURCE FILE IN THE WORKING TREE MAY CONTAIN A LITERAL NUL BYTE.
 *
 * One 0x00 anywhere makes a content-search tool classify the WHOLE file as
 * binary and stop reporting matches from it. What matters is WHICH tools do that
 * quietly, because the loud ones are harmless.
 *
 * Measured on `src/server/services/block-registry.service.ts` as it stood before
 * the accompanying fix — 168,705 bytes, one NUL at byte 136,232, `spendTier`
 * occurring 13 times across 9 lines, every one of them AFTER the NUL:
 *
 *   GNU grep 3.12, explicit file   `grep -c` -> 9, exit 0
 *   GNU grep 3.12, without -c      lines suppressed, "binary file matches" on
 *                                  STDERR, exit 0
 *   ripgrep 15.2, explicit file    `rg -c` -> 9, exit 0
 *   ripgrep 15.2, RECURSIVE        file omitted from the results entirely — no
 *                                  stderr, no diagnostic of any kind
 *   ripgrep 15.2, `rg -a`          finds it, so binary detection is the mechanism
 *   `git grep`                     unaffected, prints the lines normally
 *
 * So GNU grep degrades LOUDLY and never inverts its exit code — the opposite of
 * the folklore. The silent failure belongs to RECURSIVE ripgrep, which is how
 * agent tooling and most people actually search a repo. In a tree where some
 * other file matches the term, rg exits 0 and the affected file is simply
 * missing from the results. In a tree where nothing else matches, it exits 1
 * with no output — byte-identical to the term genuinely appearing nowhere.
 *
 * Agent tooling can also reach the silent path through plain `grep`: measured in
 * a Claude Code tool shell, `grep` is a shell FUNCTION that re-execs the claude
 * binary with `ARGV0=ugrep` and a hard-coded `-I` (ignore binary files), so bare
 * `grep -c spendTier` printed NOTHING and exited 1 — byte-identical to the same
 * wrapper searching for a term that is genuinely absent, while `command grep -c`
 * on the same file printed 9. (`command grep -I -c` prints `0` and exits 1: the
 * same "no match" semantics, not the same output.)
 *
 * That is the hazard worth a guard: a negative result indistinguishable from an
 * absence, on the tool people trust most, with nothing printed to prompt a
 * second look. Every "I searched and it isn't there" conclusion drawn over an
 * affected file is unsound — including the ones deciding that a symbol has no
 * other callers, that a migration is complete, or that a secret was never
 * committed. The file that carried this one is a spend/privilege service.
 *
 * The byte is almost never intended. In a string, write the two-character escape
 * `\0` — it produces a byte-identical runtime value. In a comment, name the byte
 * or use its Unicode control picture (␀).
 */

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Extensions where a NUL is always a mistake.
 *
 * Deliberately an allowlist of SOURCE rather than a denylist of binary: fonts,
 * images, audio and snapshots legitimately contain NULs, and enumerating what is
 * *source* is the direction that cannot produce a false failure when someone
 * adds a new binary asset type.
 *
 * `.jsx` and `.cts` currently match ZERO tracked files. They are here
 * pre-emptively and, unlike every other entry, cannot be pinned by a population
 * floor below — removing either one is a mutant this suite does not kill. Said
 * out loud rather than left for someone to discover.
 *
 * EXTENSIONLESS FILES ARE OUT OF SCOPE, deliberately. There are 48 tracked ones
 * (Dockerfiles, Makefile, LICENSE, husky hooks, dotfiles) and all 48 are text
 * today, so scanning them would find nothing. Admitting the class would mean
 * deciding, per file, whether an extensionless path is source or an arbitrary
 * binary with no name to judge it by — the allowlist's whole point is not having
 * to make that call. The residual gap is a NUL in a Dockerfile or a husky hook.
 *
 * (This paragraph used to justify the exclusion by EISDIR on the
 * `event-engine-common` gitlink, which `git ls-files` reported as a path. The
 * enumerator below walks the filesystem and classifies by dirent type, so a
 * gitlink is simply a directory and never reaches a read. That reason is gone;
 * the decision stands on the one above.)
 */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.css',
  '.scss',
  '.md',
  '.yml',
  '.yaml',
  '.html',
  '.sql',
  '.sh',
  '.svelte',
  '.prisma',
]);

/**
 * Per-extension population floors. THIS is what stops a whole file type being
 * dropped from `SOURCE_EXTENSIONS` without a test noticing.
 *
 * A single total-count floor cannot do it: with ~7,255 files matching today, a
 * floor of "more than 1000" lets 6,200 files — every `.tsx` in the repo, twice
 * over — vanish while the control still reports a serene pass. Deleting `.tsx`
 * from the set above silently unscans 1,660 files; the only assertion that can
 * see that is one that knows `.tsx` is supposed to be there in bulk.
 *
 * They also pin the EXCLUDE LIST, which is the other way this enumerator can go
 * quietly blind: adding `src` or `packages` to `EXCLUDED_DIR_NAMES` would zero
 * out whole categories here, exactly as deleting the extension does.
 *
 * Comments are the counts measured against the walk. RE-MEASURED for the switch
 * off `git ls-files`: in a clean checkout the two populations are IDENTICAL
 * file-for-file (7,255 each, zero on either side of the diff), so no floor
 * needed moving — but the numbers are from the walk now, not the index. The
 * floors sit below them so ordinary churn does not red the build; they exist to
 * catch a category going to ZERO, not to track the repo's size.
 *
 * A floor of 0 would be vacuous — it would be satisfied by an enumerator wired
 * to nothing — so every entry here is >= 2, and every extension with a nonzero
 * population has an entry. The two that do NOT (`.jsx`, `.cts`) are called out
 * above: they match zero files, so no floor can pin them.
 */
const MIN_FILES_PER_EXTENSION: Record<string, number> = {
  '.ts': 3000, // 3603
  '.tsx': 1400, // 1660
  '.sql': 600, // 730
  '.md': 300, // 412
  '.svelte': 300, // 370
  '.scss': 150, // 182
  '.mjs': 80, // 100
  '.json': 70, // 88
  '.css': 30, // 43
  '.yml': 15, // 19
  '.js': 10, // 14
  '.html': 10, // 13
  '.cjs': 5, // 7
  '.prisma': 4, // 5
  '.mts': 4, // 4
  '.yaml': 3, // 3
  '.sh': 2, // 2
};

/** 7,255 matched when the enumerator switched to a filesystem walk. */
const MIN_TOTAL_FILES = 6800;

/**
 * The extension predicate, factored out so it can be asserted directly.
 *
 * The `.toLowerCase()` is NOT decoration and no population count can pin it:
 * zero tracked files currently have an uppercase extension (measured), so
 * deleting it changes nothing about what gets scanned today and every count-based
 * control stays green. It only matters for the file someone adds tomorrow, which
 * is exactly the file this guard exists for — hence a direct test.
 */
function isSourcePath(relPath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

/** A path this run could not look at. Never conflated with "clean" — see below. */
interface Unreadable {
  rel: string;
  reason: string;
}

/**
 * Directory names that never hold source, excluded at EVERY depth.
 *
 * This guard used to enumerate with `git ls-files`, which got .gitignore for
 * free. It ran in CI and collected ZERO tests: the Tekton workspace is
 * `/workspace/source`, which is not a usable git checkout, so the enumerator
 * threw at module scope and the whole FILE failed to collect. A file that fails
 * to collect contributes no tests and reads like absence, and a gate that is
 * permanently red is a gate everyone learns to click through — so "it fails in
 * the safe direction" was not good enough.
 *
 * The fix is ONE enumeration path that works identically in CI and locally, not
 * a git-available/git-missing pair: two paths drift, and the fallback would be
 * the one that actually runs in CI while being the one nobody exercises.
 *
 * PROVENANCE — every name below is here because a `.gitignore` in this repo
 * ignores it, not because it looked generated:
 *   node_modules      root `.gitignore`, and all 7 `apps/<app>/.gitignore` files
 *   .next             root `/.next/` and `apps/<app>/.next/`
 *   out               root `/out/`
 *   build             root `/build`, and `/build` in the 4 SvelteKit apps
 *   dist              apps/{notifications,storage,orchestrator-gateway,event-engine}
 *   .svelte-kit       root `apps/<app>/.svelte-kit/`, and `/.svelte-kit` in those apps
 *   .output .vercel .netlify .wrangler   the 4 SvelteKit apps (`.vercel` at root too)
 *   coverage          root `coverage/`, and apps/event-engine
 *   .nyc_output       apps/event-engine
 *   test-results      root `/test-results/`, and apps/auth/e2e/test-results/
 *   playwright-report root `/playwright-report/`, and apps/auth/e2e/playwright-report/
 *   blob-report       root `/blob-report/`
 *   .cache            root `/playwright/.cache/`
 *   .turbo .direnv .lighthouseci .serena .playwright-mcp   root
 *   .git              not in any .gitignore — it is the object store, and the one
 *                     directory guaranteed to hold NUL bytes in every repo
 *
 * `.git` aside, nothing here is a judgement call: drop a name and the only
 * consequence is scanning generated output slower; add a wrong one and you
 * unscan real source, which is why the enumeration test below asserts the walk
 * still finds every extension in bulk.
 *
 * Matching is by NAME, before the entry's type is resolved. That is safe because
 * no name in this set carries a SOURCE_EXTENSIONS extension, so the check can
 * never drop a source FILE — and it means a dangling symlink named
 * `node_modules` costs nothing rather than being reported unreadable.
 */
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.next',
  '.svelte-kit',
  '.turbo',
  '.direnv',
  '.vercel',
  '.netlify',
  '.wrangler',
  '.output',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  'test-results',
  'playwright-report',
  'blob-report',
  '.playwright-mcp',
  '.lighthouseci',
  '.serena',
  '.cache',
]);

/**
 * The same idea for names that are ROOT-ANCHORED in `.gitignore` and must stay
 * that way. `/redis` and `/minio` are docker volume mounts at the repo root;
 * `redis` and `minio` are also perfectly ordinary directory names for real
 * source (`packages/civitai-redis`, storage adapters), so putting them in the
 * set above would unscan code. `/public/workers/` holds bundles generated by
 * `pnpm build:workers` — .js output, the one generated artefact that would
 * otherwise slip through the extension allowlist.
 */
const EXCLUDED_ROOT_PATHS = new Set([
  'public/workers',
  '.claude/worktrees',
  'analyze',
  'local',
  'src/local',
  'meilisearch',
  'data.ms',
  'redis',
  'minio',
  'prisma_pit',
  '.docker',
  '.opencode',
]);

/**
 * Bound on directory ENTRIES considered. 9,549 across 1,936 directories in this
 * repo today (measured), so 200,000 is >20x headroom and can only be reached by
 * something pathological — a symlink cycle the visited set somehow missed, or a
 * checkout with an unexpected tree grafted into it. Hitting it is reported as
 * unobservable, NOT as a pass: a truncated walk still returns thousands of files,
 * and every count-based control below would be satisfied by it.
 */
const MAX_WALK_ENTRIES = 200_000;

interface WalkResult {
  files: string[];
  unreadable: Unreadable[];
}

/**
 * THE enumerator: one filesystem walk, no git. Same code path in CI and locally.
 *
 * WHAT CHANGED, AND THE ONE CONSEQUENCE WORTH ARGUING ABOUT: a walk sees
 * UNTRACKED files that `git ls-files` hid. That is accepted, and on balance
 * preferred, because this is a PRESENCE check on a byte:
 *   - The hazard is a NUL in a file people SEARCH. Recursive ripgrep does not
 *     consult the git index; it reads the working tree. An untracked file with a
 *     NUL degrades a search exactly as a tracked one does, so a guard scoped to
 *     the index was scoped to the wrong set.
 *   - The false-failure risk is bounded and specific: a file must have a source
 *     extension, sit outside the exclude list, AND contain a real 0x00. Coverage
 *     output and build artefacts are excluded by name; a scratch `.ts` with a
 *     genuine NUL in it is the case the guard exists for, whether or not it has
 *     been `git add`ed yet.
 *   - In CI the distinction is nearly empty anyway — a fresh checkout's untracked
 *     set is generated output, which the exclude list covers.
 * The residual cost, stated rather than hidden: a developer who has a genuinely
 * binary file sitting under a source extension in their working tree will red
 * this test locally and not in CI. The remedy is the same either way — the byte
 * is real.
 *
 * SYMLINKS. Directory symlinks ARE followed. A `git worktree` of this repo
 * typically has `node_modules` symlinked at the root, and monorepos routinely
 * symlink a shared `src` into a package. `fs.readdirSync` reports a symlinked
 * directory as neither file nor directory, so without the explicit stat below
 * the walk skips whatever it points at — silently, and in the direction that
 * reports CLEAN. Cycles are bounded by a visited set keyed on the REALPATH of
 * each directory, and total work by MAX_WALK_ENTRIES.
 *
 * A symlink that cannot be resolved is UNOBSERVABLE, not clean — it goes into
 * the same `unreadable` list `scanForNul` uses, and the verdict asserts on the
 * two lists together. Reading nothing is not finding nothing.
 */
function walkSourceFiles(root: string): WalkResult {
  const files: string[] = [];
  const unreadable: Unreadable[] = [];
  const visited = new Set<string>();
  const stack: string[] = [''];
  let budget = MAX_WALK_ENTRIES;

  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = rel === '' ? root : path.join(root, rel);

    // Cycle bound. realpath collapses a symlink loop onto a directory already
    // seen; it also fails loudly on a broken link rather than silently.
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch (err) {
      unreadable.push({ rel: rel || '.', reason: errCode(err) });
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      unreadable.push({ rel: rel || '.', reason: errCode(err) });
      continue;
    }

    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (budget-- <= 0) {
        unreadable.push({
          rel: childRel,
          reason: `WALK_BUDGET_EXCEEDED after ${MAX_WALK_ENTRIES} entries — this run enumerated only part of the tree`,
        });
        return { files, unreadable };
      }

      // By name, before type resolution — see EXCLUDED_DIR_NAMES.
      if (EXCLUDED_DIR_NAMES.has(entry.name) || EXCLUDED_ROOT_PATHS.has(childRel)) continue;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(root, childRel));
        } catch (err) {
          unreadable.push({ rel: childRel, reason: errCode(err) });
          continue;
        }
        isDir = st.isDirectory();
        isFile = st.isFile();
      }

      if (isDir) stack.push(childRel);
      else if (isFile && isSourcePath(childRel)) files.push(childRel);
    }
  }

  return { files, unreadable };
}

function errCode(err: unknown): string {
  if (err instanceof Error) return (err as NodeJS.ErrnoException).code ?? err.message;
  return String(err);
}

interface ScanResult {
  /** Files that contain a literal NUL. */
  offenders: string[];
  /** Files that could NOT be read. Never conflated with "clean" — see below. */
  unreadable: Unreadable[];
}

/**
 * THE detection path. Parameterised on (root, relPaths) for one reason: it lets
 * the controls below drive this exact function over known inputs, rather than
 * over a re-implementation of it.
 *
 * That distinction was measured, not assumed. An earlier control asserted
 * `Buffer.from('a\0b').includes(0) === true`, which is a proxy for this function
 * and not this function. Blinding the real check (`buf.includes(0)` -> `false`)
 * with a genuine offender present left the whole file GREEN: the verdict saw no
 * offenders and the control sat there agreeing with itself.
 *
 * THREE-VALUED ON PURPOSE: found / clean / unreadable. This used to `continue`
 * on a read error, which silently converts "I could not look at this file" into
 * "this file is clean" — and the file it swallows is disproportionately likely to
 * be the interesting one, since the verdict's reassuring answer is an EMPTY LIST
 * and an empty list is also what a scanner that read nothing returns.
 */
function scanForNul(root: string, relPaths: string[]): ScanResult {
  const offenders: string[] = [];
  const unreadable: Unreadable[] = [];
  for (const rel of relPaths) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(root, rel));
    } catch (err) {
      unreadable.push({ rel, reason: errCode(err) });
      continue;
    }
    if (buf.includes(0)) offenders.push(rel);
  }
  return { offenders, unreadable };
}

interface Audit {
  files: string[];
  offenders: string[];
  unreadable: Unreadable[];
}

/**
 * Walk + scan, as ONE function, because the seam between them is where a gap can
 * go missing. Both halves are three-valued, and their unobservable lists merge
 * into a single verdict: a directory the WALK could not resolve and a file the
 * SCAN could not read are the same kind of hole, and neither may pass as clean.
 *
 * Asserting the two lists separately would let a run report a complete scan of an
 * INCOMPLETE enumeration — each half green in isolation, the pair broken. The
 * control below drives this function, not the two halves, for that reason.
 */
function auditTree(root: string): Audit {
  const walk = walkSourceFiles(root);
  const scan = scanForNul(root, walk.files);
  return {
    files: walk.files,
    offenders: scan.offenders,
    unreadable: [...walk.unreadable, ...scan.unreadable],
  };
}

const audit = auditTree(REPO_ROOT);
const files = audit.files;

describe('source files contain no literal NUL bytes', () => {
  // -------------------------------------------------------------------------
  // Controls first. The reassuring answer below is an EMPTY LIST, which is
  // exactly what a scanner wired to nothing also returns — so prove the
  // enumerator found the files, prove it found them in every category, and
  // prove the detector can actually fire, before reading the verdict.
  // -------------------------------------------------------------------------
  it('CONTROL: the enumerator finds a realistic number of source files', () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_TOTAL_FILES);
    expect(files).toContain('src/server/services/block-registry.service.ts');
  });

  it('CONTROL: every source extension is represented in bulk', () => {
    const counts: Record<string, number> = {};
    for (const rel of files) {
      const ext = path.extname(rel).toLowerCase();
      counts[ext] = (counts[ext] ?? 0) + 1;
    }
    for (const [ext, min] of Object.entries(MIN_FILES_PER_EXTENSION)) {
      expect(
        counts[ext] ?? 0,
        `${ext} matched ${counts[ext] ?? 0} files, expected at least ${min}. If ${ext} was ` +
          `removed from SOURCE_EXTENSIONS — or a directory holding it was added to ` +
          `EXCLUDED_DIR_NAMES — that many files are now unscanned.`
      ).toBeGreaterThanOrEqual(min);
    }
  });

  it('CONTROL: the walk excludes generated directories at EVERY depth', () => {
    // Drive `walkSourceFiles` itself, not a re-implementation of its rules.
    // Nested `node_modules` is the case that matters: a pnpm workspace puts one
    // in every app and package, and CI is where they exist.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-'));
    try {
      const write = (rel: string) => {
        fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), '// x\n');
      };
      write('keep-root.ts');
      write('src/keep-nested.ts');
      // Root-anchored names must NOT apply at depth — `redis` and `minio` are
      // ordinary source directory names below the root.
      write('src/redis/keep-redis.ts');
      write('packages/minio/keep-minio.ts');

      write('node_modules/drop.ts');
      write('packages/civitai-db/node_modules/drop.ts'); // nested — the CI case
      write('apps/auth/node_modules/deep/drop.ts');
      write('apps/storage/dist/drop.ts');
      write('.next/drop.ts');
      write('apps/auth/.svelte-kit/drop.ts');
      write('coverage/drop.ts');
      write('.git/drop.ts');
      // Root-anchored exclusions.
      write('public/workers/drop.js');
      write('redis/drop.ts');
      write('minio/drop.ts');

      const res = walkSourceFiles(dir);
      expect(res.unreadable).toEqual([]);
      expect(res.files.sort()).toEqual([
        'keep-root.ts',
        'packages/minio/keep-minio.ts',
        'src/keep-nested.ts',
        'src/redis/keep-redis.ts',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Creating a DIRECTORY symlink needs elevation or Developer Mode on Windows and fails EPERM
   * otherwise. Gated on the capability rather than on `process.platform`, so these controls still run
   * on Linux CI and on an elevated Windows shell — a platform guard would switch them off for a whole
   * OS that is usually able to run them.
   *
   * Probed once: the three controls below are the only tests that need it, and the main NUL-byte
   * assertion is unaffected and keeps running everywhere.
   */
  const canSymlink = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-probe-'));
    try {
      fs.symlinkSync(probe, path.join(probe, 'link'), 'dir');
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  })();

  it.skipIf(!canSymlink)('CONTROL: directory symlinks are followed, and a cycle terminates', () => {
    // `fs.readdirSync` reports a symlinked directory as neither file nor
    // directory, so without the explicit stat below a monorepo whose `src` is a
    // symlink into a shared package has its entire source tree skipped —
    // silently, and in the direction that reports CLEAN.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-'));
    try {
      // The target sits OUTSIDE the walked root, so the symlink is the ONLY
      // route to it. An earlier version of this control put the real directory
      // inside the root as well — and a mutant that stopped following symlinks
      // passed it, because the file was still reachable the ordinary way. The
      // assertion has to be unsatisfiable without the behaviour it names.
      fs.mkdirSync(path.join(base, 'shared'));
      fs.writeFileSync(path.join(base, 'shared/found.ts'), '// x\n');
      const root = path.join(base, 'repo');
      fs.mkdirSync(root);
      fs.symlinkSync(path.join(base, 'shared'), path.join(root, 'src'), 'dir');
      // A loop back to the root: without the realpath visited set this recurses
      // until the entry budget and never returns a clean result.
      fs.symlinkSync(root, path.join(root, 'loop'), 'dir');

      const res = walkSourceFiles(root);
      expect(res.unreadable).toEqual([]);
      expect(res.files).toEqual(['src/found.ts']);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.skipIf(!canSymlink)('CONTROL: an unresolvable symlink is UNOBSERVABLE, not clean', () => {
    // Same three-valued discipline as the read path: a link the walk cannot
    // resolve is a gap in the evidence, and must not leave through the same
    // door as a directory that was genuinely empty.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'found.ts'), '// x\n');
      fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling'), 'dir');

      const res = walkSourceFiles(dir);
      expect(res.files).toEqual(['found.ts']);
      expect(res.unreadable.map((u) => u.rel)).toEqual(['dangling']);
      expect(res.unreadable[0].reason).toBe('ENOENT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CONTROL: a root that cannot be enumerated is UNOBSERVABLE, not empty', () => {
    // This is the shape of the failure that motivated the whole change: an
    // enumerator that cannot see the tree must not return a short, serene list.
    // Both cases are root-proof — even uid 0 gets ENOENT and ENOTDIR — so they
    // hold in a CI container running as root, where a chmod-based test would
    // silently invert.
    const missing = walkSourceFiles(path.join(os.tmpdir(), 'nul-guard-does-not-exist-9d3f'));
    expect(missing.files).toEqual([]);
    expect(missing.unreadable.map((u) => u.reason)).toEqual(['ENOENT']);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-')), 'notadir.ts');
    try {
      fs.writeFileSync(file, '// x\n');
      const notADir = walkSourceFiles(file);
      expect(notADir.files).toEqual([]);
      expect(notADir.unreadable.map((u) => u.reason)).toEqual(['ENOTDIR']);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it.skipIf(!canSymlink)(
    'CONTROL: the end-to-end audit merges WALK gaps and SCAN gaps into one verdict',
    () => {
      // Drives `auditTree`, the function the verdict actually calls. Each half is
      // pinned above in isolation; this pins the SEAM. Dropping the walk's
      // unobservable list from the merge leaves both halves green and the pair
      // reporting a complete scan of an incomplete enumeration.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-'));
      try {
        fs.writeFileSync(path.join(dir, 'clean.ts'), 'const a = `x\\0y`;\n');
        fs.writeFileSync(path.join(dir, 'dirty.ts'), Buffer.from('const a = `x\0y`;\n', 'utf8'));
        fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling'), 'dir');

        const res = auditTree(dir);
        expect(res.files.sort()).toEqual(['clean.ts', 'dirty.ts']);
        expect(res.offenders).toEqual(['dirty.ts']);
        expect(res.unreadable.map((u) => u.rel)).toEqual(['dangling']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('CONTROL: the extension filter is case-insensitive', () => {
    // No file in the tree currently has an uppercase extension, so the
    // population counts above cannot see this. Assert the predicate directly.
    expect(isSourcePath('src/a/Component.TSX')).toBe(true);
    expect(isSourcePath('src/a/Component.tsx')).toBe(true);
    expect(isSourcePath('src/a/QUERY.SQL')).toBe(true);
    expect(isSourcePath('src/a/sprite.PNG')).toBe(false);
  });

  it('CONTROL: the real scan reports a known-bad file and spares a clean one', () => {
    // Drive `scanForNul` itself over a directory built for the purpose. The
    // positive case is the whole point: the verdict below is an EMPTY LIST, and
    // an empty list is what a blind detector returns too. Watching this go
    // non-empty is the only thing separating those.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-'));
    try {
      // Negative: the two-character ESCAPE as it appears in SOURCE. It must not
      // be mistaken for the byte.
      fs.writeFileSync(path.join(dir, 'clean.ts'), 'const a = `x\\0y`;\n');
      // Positive: the escape below is resolved by THIS file's compiler, so the
      // bytes on disk contain a real 0x00.
      fs.writeFileSync(path.join(dir, 'dirty.ts'), Buffer.from('const a = `x\0y`;\n', 'utf8'));

      const both = scanForNul(dir, ['clean.ts', 'dirty.ts']);
      expect(both.offenders).toEqual(['dirty.ts']);
      expect(both.unreadable).toEqual([]);

      const cleanOnly = scanForNul(dir, ['clean.ts']);
      expect(cleanOnly.offenders).toEqual([]);
      expect(cleanOnly.unreadable).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CONTROL: an unreadable path is REPORTED, never counted as clean', () => {
    // The failure this pins: `catch { continue }`. A file that cannot be read is
    // not evidence of anything, and a genuine offender that happens to be
    // unreadable must not leave via the same door as a clean file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'dirty.ts'), Buffer.from('x\0y\n', 'utf8'));
      const res = scanForNul(dir, ['dirty.ts', 'vanished.ts']);
      expect(res.offenders).toEqual(['dirty.ts']);
      expect(res.unreadable.map((u) => u.rel)).toEqual(['vanished.ts']);
      expect(res.unreadable[0].reason).toBe('ENOENT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no source file contains a NUL byte', () => {
    const { offenders, unreadable } = audit;

    expect(
      unreadable,
      'Part of the tree could not be read, so this run cannot claim it is clean. Fix the ' +
        'read error rather than ignoring it — a NUL in an unreadable file is exactly what ' +
        'this guard would otherwise miss.'
    ).toEqual([]);

    expect(
      offenders,
      'A literal NUL makes RECURSIVE ripgrep drop the whole file from its results with no ' +
        'diagnostic, so searches over it return a false negative indistinguishable from an ' +
        'absence. Write the two-character escape \\0 instead — it is byte-identical at runtime.'
    ).toEqual([]);
  });
});
