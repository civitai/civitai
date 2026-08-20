#!/usr/bin/env node
/**
 * Typecheck every app under `apps/` — and be able to prove it did.
 *
 * The root `pnpm run typecheck` is bounded by the root tsconfig `include`, which has no
 * `apps/*` entry, so no app has ever been typechecked by CI. Both tiers (the Actions
 * `typecheck` job and the `tekton / typecheck` status) run that same script, so this was
 * never a gap that would close on its own.
 *
 * Wiring it as one `pnpm --filter <pkg> run typecheck` step per app is the obvious shape,
 * and it has two failure modes that both report SUCCESS:
 *
 *   1. `pnpm --filter <name> run <script>` EXITS 0 WHEN THE FILTER MATCHES NOTHING. Measured
 *      on pnpm 10.28.1: a bogus package name prints `No projects matched the filters` and
 *      exits 0. A hardcoded list of six package names is six chances for a rename or a typo
 *      to turn a gate into a no-op that still shows a green check. Same shape as
 *      `prettier --check "$FILES"` reporting "All matched files use Prettier code style!"
 *      over zero files.
 *   2. A NEW app added under `apps/` is simply absent from the list. The gate stays green
 *      and the app is unchecked — the exact hole this script exists to close, reopened by
 *      the next person to add an app, with nothing to say so.
 *
 * So the app set is a LEDGER DERIVED FROM DISK, never a hardcoded list: every `apps/*` with
 * a `typecheck` script must run, and each run must be proven to have selected a real
 * package. Adding an app wires it automatically; removing one needs no edit here.
 *
 * Failures are COLLECTED, not fatal on the first. Six sequential steps abort the job at the
 * first red app, so a shared type change that breaks four of them reports one. The summary
 * at the end names every failing app.
 *
 * Usage:  node scripts/ci/typecheck-apps.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/**
 * Apps deliberately NOT gated yet, each with the reason it is out.
 *
 * An entry here is a claim that the app still exists and still needs the exemption. A stale
 * exclusion is worse than no exclusion: it silently un-gates an app that was fixed years
 * ago. So an entry naming a directory that is gone, or an app that no longer has a
 * `typecheck` script, is a hard error rather than a no-op.
 */
const EXCLUDED = {
  auth: [
    'Two pre-existing errors, reproduced 2026-08-19 and 2026-08-20:',
    '  src/lib/server/auth/providers.ts:165 — Parameter \'p\' implicitly has an \'any\' type',
    '  src/lib/server/auth/__tests__/establish-session.test.ts:100 — \'_store\' on type \'never\'',
    'Wiring it before those are fixed ships a permanently-red gate, which teaches people to',
    'click through every other app\'s result too. Fix, then delete this entry.',
  ].join('\n    '),
};

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const appsDir = join(repoRoot, 'apps');

/** Every apps/* member that declares a `typecheck` script, read from disk. */
function discoverApps() {
  const found = [];
  for (const dir of readdirSync(appsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgPath = join(appsDir, dir.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts?.typecheck) continue;
    found.push({ dir: dir.name, name: pkg.name });
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

const all = discoverApps();

// A stale exclusion silently un-gates an app. Fail loudly instead.
const staleExclusions = Object.keys(EXCLUDED).filter((d) => !all.some((a) => a.dir === d));
if (staleExclusions.length) {
  console.error(
    `EXCLUDED names an app that no longer has a typecheck script (or no longer exists): ` +
      `${staleExclusions.join(', ')}.\nRemove the entry from scripts/ci/typecheck-apps.mjs.`
  );
  process.exit(2);
}

const targets = all.filter((a) => !(a.dir in EXCLUDED));

// Discovering nothing must never read as success — that is the whole failure class above.
if (targets.length === 0) {
  console.error('No apps/* with a typecheck script were discovered. Refusing to report success.');
  process.exit(2);
}

console.log(`Typechecking ${targets.length} app(s): ${targets.map((a) => a.dir).join(', ')}`);
for (const [dir, why] of Object.entries(EXCLUDED)) {
  console.log(`\nSkipping ${dir}:\n    ${why}`);
}
console.log('');

const failed = [];
for (const app of targets) {
  console.log(`::group::typecheck ${app.dir} (${app.name})`);
  const run = spawnSync('pnpm', ['--filter', app.name, 'run', 'typecheck'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // Inherit stderr so tsc/svelte-check diagnostics land in the log as they happen;
    // capture stdout so the no-match sentinel below can be read.
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const stdout = run.stdout ?? '';
  process.stdout.write(stdout);
  console.log('::endgroup::');

  if (run.error) {
    failed.push(`${app.dir}: could not spawn pnpm (${run.error.message})`);
    continue;
  }

  // The exit-0-on-empty-filter case. pnpm says so on stdout and returns success; without
  // this the app is silently never checked.
  if (/No projects matched the filters/i.test(stdout)) {
    failed.push(
      `${app.dir}: pnpm matched NO package for "${app.name}" — the filter is stale, so this ` +
        `app was not typechecked (pnpm exits 0 in this case)`
    );
    continue;
  }

  if (run.status !== 0) {
    failed.push(`${app.dir}: typecheck failed (exit ${run.status})`);
  }
}

console.log(`\n${'='.repeat(60)}`);
if (failed.length) {
  console.error(`${failed.length} of ${targets.length} app(s) failed typecheck:`);
  for (const f of failed) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`All ${targets.length} app(s) passed typecheck.`);
