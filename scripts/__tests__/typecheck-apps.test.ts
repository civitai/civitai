/**
 * Guard proofs for `scripts/ci/typecheck-apps.mjs`.
 *
 * That script is the only thing standing between "apps/ is typechecked" and a green check
 * over nothing, so each of its guards is exercised here against a known input. Every case
 * builds a throwaway repo root with a stub `apps/` tree and a FAKE `pnpm` on PATH, which is
 * what lets the no-match and failure paths be driven deterministically without installing
 * the monorepo.
 *
 * EXCLUSIONS ARE INJECTED, NOT INHERITED. The shipped `EXCLUDED` map is empty (every app is
 * gated), and an earlier version of this suite encoded "auth is excluded" into every fixture
 * — so emptying the map broke six of eight cases for reasons unrelated to what they test.
 * The exclusion guards are the ones the NEXT excluded app will depend on, so they are driven
 * here through `runTypecheckApps({ excluded })` with a SYNTHETIC app instead: they stay
 * covered no matter what the real map happens to contain today.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXCLUDED } from '../ci/typecheck-apps.mjs';

const SCRIPT = resolve(fileURLToPath(new URL('../ci/typecheck-apps.mjs', import.meta.url)));

/**
 * Test-only entrypoint: imports the REAL module and calls it with an injected exclusion map,
 * so the injected-exclusion cases still run the genuine script end-to-end (real spawn of the
 * fake pnpm, real discovery off disk) rather than a reimplementation of it.
 *
 * This is a fixture file, never shipped — the production script takes no exclusion override,
 * because an env-var/argv one would be a live way to un-gate an app in CI.
 */
const DRIVER = `import { runTypecheckApps } from './typecheck-apps.mjs';
process.exit(runTypecheckApps({ excluded: JSON.parse(process.argv[2]) }));
`;

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'typecheck-apps-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;

/** A throwaway repo root: the real script, a stub apps/ tree, and a fake pnpm on PATH. */
function makeRepo(apps: Record<string, boolean>, pnpmBody: string) {
  const dir = join(root, `case-${seq++}`);
  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  cpSync(SCRIPT, join(dir, 'scripts', 'ci', 'typecheck-apps.mjs'));
  writeFileSync(join(dir, 'scripts', 'ci', 'run-with-exclusions.mjs'), DRIVER);

  for (const [app, hasTypecheck] of Object.entries(apps)) {
    mkdirSync(join(dir, 'apps', app), { recursive: true });
    writeFileSync(
      join(dir, 'apps', app, 'package.json'),
      JSON.stringify({
        name: `@civitai/${app}`,
        scripts: hasTypecheck ? { typecheck: 'true' } : {},
      })
    );
  }

  const fake = join(dir, 'bin', 'pnpm');
  writeFileSync(fake, `#!/usr/bin/env bash\n${pnpmBody}\n`);
  chmodSync(fake, 0o755);
  return dir;
}

function spawnIn(dir: string, args: string[]) {
  const r = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}` },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Run the script with an EXPLICIT exclusion map — `{}` by default.
 *
 * Every mechanism case below goes through here, so none of them can be perturbed by what
 * the shipped map happens to contain. That coupling is not hypothetical: while writing this
 * suite, re-adding a single shipped exclusion broke six unrelated cases, because their
 * fixtures had no directory for the excluded app and so tripped the stale-exclusion guard
 * before reaching the assertion under test.
 */
function run(dir: string, excluded: Record<string, string> = {}) {
  return spawnIn(dir, ['scripts/ci/run-with-exclusions.mjs', JSON.stringify(excluded)]);
}

/** Run the REAL CI entrypoint: `node scripts/ci/typecheck-apps.mjs`, shipped map and all. */
function runShipped(dir: string) {
  return spawnIn(dir, ['scripts/ci/typecheck-apps.mjs']);
}

/**
 * POSIX only. The fixtures put a fake `pnpm` on PATH as a `#!/usr/bin/env bash` script made executable
 * with `chmod 0755` — neither the shebang nor the mode bit means anything on Windows, where a spawned
 * `pnpm` resolves through PATHEXT and would need a `.cmd`. Porting the fixtures would mean maintaining
 * two dialects of every stub for a script that only ever runs on Linux CI, and a stub that drifts from
 * the one CI uses is worse than no local run.
 *
 * Skipped, not deleted: it reports as skipped rather than vanishing, so the gap is visible. The script
 * itself is covered on CI, which is the platform it runs on.
 */
describe.skipIf(process.platform === 'win32')('typecheck-apps', () => {
  it('passes when every discovered app typechecks clean', () => {
    const { code, out } = run(makeRepo({ alpha: true, beta: true }, 'exit 0'));
    expect(out).toContain('All 2 app(s) passed typecheck');
    expect(code).toBe(0);
  });

  it('fails a stale pnpm filter, which exits 0 while checking nothing', () => {
    // The defect this script exists for: `pnpm --filter <unknown>` prints
    // "No projects matched the filters" and EXITS 0 (measured, pnpm 10.28.1). Wired as a
    // plain workflow step, a renamed package silently stops being typechecked.
    const dir = makeRepo(
      { alpha: true },
      'echo "No projects matched the filters in \\"/repo\\""; exit 0'
    );
    const { code, out } = run(dir);
    expect(out).toContain('matched NO package');
    expect(code).toBe(1);
  });

  it('fails when an app’s typecheck fails', () => {
    const { code, out } = run(makeRepo({ alpha: true }, 'exit 1'));
    expect(out).toContain('alpha: typecheck failed');
    expect(code).toBe(1);
  });

  it('collects every failure instead of stopping at the first app', () => {
    // Sequential workflow steps abort the job at the first red app, so a shared type change
    // that breaks four of them reports one. This is the difference.
    const { code, out } = run(makeRepo({ alpha: true, beta: true }, 'exit 1'));
    expect(out).toContain('2 of 2 app(s) failed typecheck');
    expect(out).toContain('alpha:');
    expect(out).toContain('beta:');
    expect(code).toBe(1);
  });

  it('refuses to report success when it discovers no apps', () => {
    // A zero that reads as a pass is the whole failure class. Nothing here has a typecheck
    // script, so discovery comes back empty.
    const { code, out } = run(makeRepo({ alpha: false }, 'exit 0'));
    expect(out).toContain('Refusing to report success');
    expect(code).toBe(2);
  });

  it('picks up a newly added app with no edit to the workflow', () => {
    // The hole reopens the moment someone adds an app to a hardcoded list they did not know
    // about. The ledger is read from disk, so it cannot go stale that way.
    const { code, out } = run(makeRepo({ alpha: true, brandnew: true }, 'exit 0'));
    expect(out).toContain('Typechecking 2 app(s): alpha, brandnew');
    expect(code).toBe(0);
  });

  // --- the exclusion mechanism, driven with a synthetic app ---

  it('hard-fails on a stale exclusion rather than silently un-gating', () => {
    // If an excluded app is fixed or removed but its EXCLUDED entry survives, that entry is
    // a lie. Failing loudly is what stops an app quietly leaving the gate. `ghost` exists in
    // the exclusion map but not on disk.
    const { code, out } = run(makeRepo({ alpha: true }, 'exit 0'), { ghost: 'no longer real' });
    expect(out).toContain('no longer has a typecheck script');
    expect(out).toContain('ghost');
    expect(code).toBe(2);
  });

  it('skips an excluded app while still checking everything else', () => {
    const dir = makeRepo({ alpha: true, legacy: true }, 'exit 0');
    const { code, out } = run(dir, { legacy: 'known broken, tracked in ISSUE-1' });
    expect(out).toContain('Typechecking 1 app(s): alpha');
    expect(out).toContain('Skipping legacy');
    expect(out).toContain('known broken, tracked in ISSUE-1');
    expect(code).toBe(0);
  });

  it('refuses to report success when every discovered app is excluded', () => {
    // The other route to an empty target set: discovery finds apps, but the exclusion map
    // eats all of them. That must not read as a pass either.
    const { code, out } = run(makeRepo({ legacy: true }, 'exit 0'), { legacy: 'known broken' });
    expect(out).toContain('Refusing to report success');
    expect(code).toBe(2);
  });

  // --- the shipped ledger ---

  it('ships no exclusion for auth, so auth is inside the gate', () => {
    // auth was the last excluded app; its two type errors are fixed. This pins that it did
    // not quietly get re-excluded. Excluding a DIFFERENT app in future must NOT fail here,
    // so the fixture grows a directory for every shipped exclusion (otherwise the
    // stale-exclusion guard would fire and this case would die for the wrong reason).
    expect(Object.keys(EXCLUDED)).not.toContain('auth');

    // …and behaviourally, through the REAL entrypoint: an `auth` app on disk is a target,
    // not a skip. This is also the only case that proves `node scripts/ci/typecheck-apps.mjs`
    // still self-executes — the direct-run guard added alongside the exported function.
    const fixture: Record<string, boolean> = { alpha: true, auth: true };
    for (const excludedDir of Object.keys(EXCLUDED)) fixture[excludedDir] = true;

    const { code, out } = runShipped(makeRepo(fixture, 'exit 0'));
    const ledger = /Typechecking \d+ app\(s\): (.*)/.exec(out)?.[1] ?? '';
    expect(ledger.split(', ')).toContain('auth');
    expect(out).not.toContain('Skipping auth');
    expect(code).toBe(0);
  });
});
