#!/usr/bin/env node
/**
 * Blocking guard: the INSTALLED Next unblocks the libvips SVG loader that `next/og` needs.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT ONLY AS A TEST. The behavioural regression guard for
 * the 2026-08-08 `/api/og` outage lives in `src/tests/api/og.image-optimizer-sharp.test.ts`,
 * which runs in the `Unit tests` job — and that job is `continue-on-error: true`, so it
 * reports without gating. A guard that cannot fail a build is a notification. This is the
 * same structural assertion in a form a blocking job can run in ~50ms: no database, no
 * sharp, no browser, no network, no Next module graph — one file read per installed copy.
 *
 * WHAT IT ASSERTS, AND WHY THAT IS THE RIGHT INVARIANT. Next 16.3.0 applies a process-global
 * libvips block on first image-optimizer use and re-enables only six RASTER loaders; SVG is
 * not among them, so every `ImageResponse` in the process throws
 * `Input buffer contains unsupported image format` from then on. Upstream fixed that in
 * vercel/next.js#96681, and 16.3.1 is the first release that CONTAINS the fix: it ships
 * `'VipsForeignLoadSvg'` in the unblock list itself. We carried the one-line fix as a pnpm
 * patch only while we were on 16.3.0; there is no Next patch now, and this guard needs none.
 *
 * So what this protects against today is a FUTURE Next regressing the loader entry again —
 * which is exactly why the assertion is deliberately "the installed Next unblocks SVG", NOT
 * "our patch file is on disk" and NOT "we are on any particular version":
 *
 *   - reading `node_modules` rather than `patches/` is the whole point. It is the only form
 *     that is correct both now (upstream supplies the entry, no patch exists) and in the
 *     patched past (a patch that exists but did not APPLY — unregistered key, failed hunk, a
 *     stale lockfile hash — is exactly the silent failure this catches, and a patch-file grep
 *     would sail through it);
 *   - staying version-agnostic means the guard does not have to be retired, re-pinned or
 *     re-dated in the same commit that bumps Next. It keeps passing on any Next that unblocks
 *     the loader, and goes red the moment one does not — whoever hits that decides between
 *     re-introducing a patch and pinning back.
 *
 * 🔴 One occurrence per copy is NOT evidence about WHO supplied it. The count is the same
 * whether upstream ships the entry or a patch inserted it, so it cannot distinguish the two —
 * reading it as proof of a working patch is how the now-deleted 16.3.1 patch was carried for
 * a while after it had gone inert (pnpm silently no-ops an already-applied patch: rc=0, no
 * warning, and it still creates a `patch_hash=…` virtual-store dir, so it LOOKS applied).
 * To attribute the entry, compare the installed file against the pristine published tarball —
 * on 16.3.1 they are byte-identical, so upstream is the source.
 *
 * BOTH BUILDS, SKIPPING WHAT IS ABSENT. Next ships this module twice — `dist/server/` (CJS)
 * and `dist/esm/server/`. A full `pnpm install` has both; the production standalone image has
 * only the CJS copy, because `@vercel/nft` never traces the ESM twin into the output. So an
 * absent copy is skipped rather than failed, or this check would be wrong in one of the two
 * environments it has to be correct in. Zero copies found is a HARD failure: that is the
 * shape a vacuous pass would take, and a guard that reports OK having read nothing is worse
 * than no guard.
 *
 * Usage:  node scripts/ci/assert-next-svg-patch-applied.mjs
 * Exit:   0 = every installed copy unblocks SVG · 1 = a copy is missing it, or none was found
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

const REQUIRED_LOADER = 'VipsForeignLoadSvg';

// Relative to the installed `next` package root. Order is reporting order only.
const COPIES = [
  { label: 'cjs', path: 'dist/server/image-optimizer.js' },
  { label: 'esm', path: 'dist/esm/server/image-optimizer.js' },
];

// The `sharp.unblock({ operation: [...] })` call in `getSharp()`. If Next ever restructures
// this the regex stops matching, and that is reported as a failure rather than shrugged off:
// "the shape I knew how to check is gone" must not read the same as "the check passed".
const UNBLOCK_CALL = /unblock\(\{\s*operation:\s*\[([^\]]*)\]/;

/**
 * @returns {{ ok: boolean, checked: number, results: Array<{label: string, file: string,
 *   state: 'ok' | 'missing-loader' | 'no-unblock-call' | 'absent'}>, error?: string }}
 */
function checkInstalledNext() {
  const require = createRequire(import.meta.url);

  let nextRoot;
  try {
    nextRoot = dirname(require.resolve('next/package.json'));
  } catch (error) {
    return {
      ok: false,
      checked: 0,
      results: [],
      error:
        'could not resolve the installed `next` package. This check has measured nothing — ' +
        `install dependencies before running it. (${error.message})`,
    };
  }

  const results = COPIES.map(({ label, path }) => {
    const file = join(nextRoot, path);
    if (!existsSync(file)) return { label, file, state: 'absent' };

    const match = UNBLOCK_CALL.exec(readFileSync(file, 'utf8'));
    if (!match) return { label, file, state: 'no-unblock-call' };

    return { label, file, state: match[1].includes(REQUIRED_LOADER) ? 'ok' : 'missing-loader' };
  });

  const checked = results.filter((r) => r.state !== 'absent').length;
  return {
    ok: checked > 0 && results.every((r) => r.state === 'ok' || r.state === 'absent'),
    checked,
    results,
  };
}

/** Human-readable lines; stdout is what a failing test surfaces as its message. */
function formatReport(report) {
  const lines = [];
  for (const { label, file, state } of report.results) {
    const shown = relative(process.cwd(), file);
    if (state === 'ok') lines.push(`     ok  ${label}  ${shown} unblocks ${REQUIRED_LOADER}`);
    else if (state === 'absent') lines.push(`   skip  ${label}  ${shown} is not installed`);
    else if (state === 'no-unblock-call')
      lines.push(`   FAIL  ${label}  ${shown} has no sharp.unblock({ operation: [...] }) call`);
    else lines.push(`   FAIL  ${label}  ${shown} does NOT unblock ${REQUIRED_LOADER}`);
  }
  lines.push(`copies of image-optimizer.js read: ${report.checked}`);
  if (report.error) lines.push(`FAIL: ${report.error}`);
  return lines;
}

const FAILURE_EXPLANATION =
  `FAIL: the installed Next does not unblock the libvips SVG loader (${REQUIRED_LOADER}).\n` +
  'Every `next/og` ImageResponse — i.e. all of /api/og — will return 500 as soon as anything\n' +
  'touches the image optimizer in that process.\n' +
  'Next >= 16.3.1 ships this loader entry itself (vercel/next.js#96681), and we carry no Next\n' +
  'patch, so this failing means the Next you installed has REGRESSED it — or dependencies are\n' +
  'stale. Re-run `pnpm install` and re-check; if the installed Next genuinely lacks the entry,\n' +
  'pin Next back to a release that unblocks the loader, or re-introduce a pnpm patch adding\n' +
  `'${REQUIRED_LOADER}' to the sharp.unblock({ operation: [...] }) list in BOTH\n` +
  'dist/server/image-optimizer.js and dist/esm/server/image-optimizer.js. This reads\n' +
  'node_modules, not patches/, so it judges the artifact you actually installed however the\n' +
  'entry got there. See src/tests/api/og.image-optimizer-sharp.test.ts for the outage.';

const NO_COPIES_EXPLANATION =
  'FAIL: found no copy of next/dist/**/server/image-optimizer.js to read, so this check ' +
  'proved nothing. Either dependencies are not installed or Next moved the module.';

// Nothing imports this — the unit test spawns it as a subprocess so that it exercises the
// exact command CI runs, exit code included. Keep it that way: an importable copy of the
// assertion is a second copy of the assertion.
const report = checkInstalledNext();
for (const line of formatReport(report)) console.log(line);

if (!report.ok) {
  console.error(`\n${report.checked === 0 ? NO_COPIES_EXPLANATION : FAILURE_EXPLANATION}`);
  process.exit(1);
}
console.log(`\nOK: all ${report.checked} installed copy/copies unblock ${REQUIRED_LOADER}.`);
