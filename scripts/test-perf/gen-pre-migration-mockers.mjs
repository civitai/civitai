#!/usr/bin/env node
/**
 * Freeze the pre-migration mocker population into
 * src/__tests__/mocks/pre-migration-mockers.json.
 *
 *   node scripts/test-perf/gen-pre-migration-mockers.mjs [base-rev]
 *
 * Which test files carried a direct `vi.mock` of a guarded specifier at the commit the shared-mock
 * migration branched from. It is the DENOMINATOR for `unit-fast`'s earned-membership count, and it
 * is committed rather than derived at generate time for two reasons:
 *
 *   1. CI checks out shallow, so `git show <base>:<file>` is not available where the manifest's
 *      `--check` runs.
 *   2. It is a fact about a past commit. A number that can silently drift is not a baseline.
 *
 * 🔴 Why a baseline is needed at all: membership counted on the CURRENT tree cannot see the
 * migration. Converting a file REMOVES its mocks, so a converted member reads exactly like a member
 * that never mocked anything, and the migration is credited with zero. Measured: the manifest's
 * own present-tense count moved 4 -> 5 across a day that converted 127 files, while the same member
 * sets scored 23 -> 46 against this baseline.
 *
 * That is the mirror of the trap already recorded for the burn-down — measuring by absence inflates
 * a burn-down and deflates an earned count, and the flattering direction is not the same one twice.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(repoRoot, 'src/__tests__/mocks/pre-migration-mockers.json');
const ALLOWLIST = path.join(repoRoot, 'src/__tests__/mocks/direct-mock-allowlist.json');

// The commit `perf/test-mock-system` branched from — the last state of `main` with no canonical
// mocks in it. Every migration branch in this lane descends from it.
const DEFAULT_BASE = '3863adcbb04c03465a6c7c5d64d2878406051c54';
const base = process.argv[2] ?? DEFAULT_BASE;

const git = (args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 });

const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
const guarded = [...allowlist.canonicalSpecifiers, ...allowlist.pendingSpecifiers].sort();

const testFiles = git(['ls-tree', '-r', '--name-only', base, '--', 'src', 'scripts'])
  .split('\n')
  .filter((f) => f.endsWith('.test.ts'));

const carried = [];
for (const file of testFiles) {
  let src;
  try {
    src = git(['show', `${base}:${file}`]);
  } catch {
    continue;
  }
  if (guarded.some((g) => src.includes(`vi.mock('${g}'`) || src.includes(`vi.mock("${g}"`)))
    carried.push(file);
}

// A scan that can only return zero has told you nothing. This one is known to have a nonzero
// answer at the default base, so an empty result means the scan broke, not that the tree is clean.
if (!carried.length) {
  console.error(
    `Zero files at ${base} carry a guarded vi.mock. The scan is blind; refusing to write.`
  );
  process.exit(2);
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      base: git(['rev-parse', base]).trim(),
      baseSubject: git(['log', '-1', '--format=%s', base]).trim(),
      guardedSpecifiers: guarded,
      testFilesAtBase: testFiles.length,
      files: carried.sort(),
    },
    null,
    2
  )}\n`
);
console.log(
  `${carried.length} of ${testFiles.length} test files carried a guarded mock at ${base}`
);
