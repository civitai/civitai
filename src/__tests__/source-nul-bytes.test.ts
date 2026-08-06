import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 NO TRACKED SOURCE FILE MAY CONTAIN A LITERAL NUL BYTE.
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
 * today, so scanning them would find nothing — but "has no extension" is not a
 * safe proxy for "is a file": the repo's `event-engine-common` submodule is a
 * tracked gitlink with no extension that is a DIRECTORY on disk, and reading it
 * raises EISDIR. Admitting the class would mean special-casing gitlinks to stop
 * the unreadable check below firing on every run. The residual gap is a NUL in a
 * Dockerfile or a husky hook.
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
 * A single total-count floor cannot do it: with ~7,221 files matching today, a
 * floor of "more than 1000" lets 6,200 files — every `.tsx` in the repo, twice
 * over — vanish while the control still reports a serene pass. Deleting `.tsx`
 * from the set above silently unscans 1,656 files; the only assertion that can
 * see that is one that knows `.tsx` is supposed to be there in bulk.
 *
 * Comments are the counts measured when this landed. The floors sit well below
 * them so ordinary churn does not red the build; they exist to catch a category
 * going to ZERO, not to track the repo's size.
 */
const MIN_FILES_PER_EXTENSION: Record<string, number> = {
  '.ts': 3000, // 3577
  '.tsx': 1400, // 1656
  '.sql': 600, // 728
  '.md': 300, // 411
  '.svelte': 300, // 370
  '.scss': 150, // 181
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

/** 7,221 matched when this landed. */
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

/** Tracked files only — `git ls-files` respects .gitignore and skips build output. */
function trackedSourceFiles(): string[] {
  let out: Buffer;
  try {
    out = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    // This call is at module scope, so an unwrapped throw fails the whole FILE
    // to COLLECT, reporting only `spawnSync git ENOENT` (no git binary) or
    // `Command failed: git ls-files -z` (not a git checkout) — both measured,
    // and neither names this guard or says what to do about it. Failing is the
    // right direction; failing anonymously is not.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `source-nul-bytes guard: could not enumerate tracked files via \`git ls-files\` in ` +
        `${REPO_ROOT}. This guard requires a git checkout and a \`git\` binary on PATH. It ` +
        `deliberately does not fall back to walking the filesystem, which would scan ` +
        `node_modules and build output. Underlying error: ${detail}`
    );
  }
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0 && isSourcePath(p));
}

const files = trackedSourceFiles();

interface ScanResult {
  /** Files that contain a literal NUL. */
  offenders: string[];
  /** Files that could NOT be read. Never conflated with "clean" — see below. */
  unreadable: { rel: string; reason: string }[];
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
  const unreadable: { rel: string; reason: string }[] = [];
  for (const rel of relPaths) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(root, rel));
    } catch (err) {
      const reason =
        err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err);
      unreadable.push({ rel, reason });
      continue;
    }
    if (buf.includes(0)) offenders.push(rel);
  }
  return { offenders, unreadable };
}

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
        `${ext} matched ${counts[ext] ?? 0} tracked files, expected at least ${min}. ` +
          `If ${ext} was removed from SOURCE_EXTENSIONS, that many files are now unscanned.`
      ).toBeGreaterThanOrEqual(min);
    }
  });

  it('CONTROL: the extension filter is case-insensitive', () => {
    // No tracked file currently has an uppercase extension, so the population
    // counts above cannot see this. Assert the predicate directly.
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

  it('no tracked source file contains a NUL byte', () => {
    const { offenders, unreadable } = scanForNul(REPO_ROOT, files);

    expect(
      unreadable,
      'Some tracked source files could not be read, so this run cannot claim they are ' +
        'clean. Fix the read error rather than ignoring it — a NUL in an unreadable file ' +
        'is exactly what this guard would otherwise miss.'
    ).toEqual([]);

    expect(
      offenders,
      'A literal NUL makes RECURSIVE ripgrep drop the whole file from its results with no ' +
        'diagnostic, so searches over it return a false negative indistinguishable from an ' +
        'absence. Write the two-character escape \\0 instead — it is byte-identical at runtime.'
    ).toEqual([]);
  });
});
