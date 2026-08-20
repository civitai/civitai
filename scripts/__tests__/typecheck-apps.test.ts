/**
 * Guard proofs for `scripts/ci/typecheck-apps.mjs`.
 *
 * That script is the only thing standing between "apps/ is typechecked" and a green check
 * over nothing, so each of its guards is exercised here against a known input. Every case
 * builds a throwaway repo root with a stub `apps/` tree and a FAKE `pnpm` on PATH, which is
 * what lets the no-match and failure paths be driven deterministically without installing
 * the monorepo.
 *
 * The fixtures all include an `auth` app on purpose: the script treats an EXCLUDED entry
 * naming a missing app as a hard error, so omitting it makes every case fail for that
 * reason instead of the one under test. (Learned the hard way — the first draft of this
 * suite did exactly that and six cases died for the wrong reason.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  fileURLToPath(new URL('../ci/typecheck-apps.mjs', import.meta.url))
);

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

function run(dir: string) {
  const r = spawnSync(process.execPath, ['scripts/ci/typecheck-apps.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const AUTH = { auth: true };

describe('typecheck-apps', () => {
  it('passes when every discovered app typechecks clean', () => {
    const { code, out } = run(makeRepo({ ...AUTH, alpha: true, beta: true }, 'exit 0'));
    expect(out).toContain('All 2 app(s) passed typecheck');
    expect(code).toBe(0);
  });

  it('fails a stale pnpm filter, which exits 0 while checking nothing', () => {
    // The defect this script exists for: `pnpm --filter <unknown>` prints
    // "No projects matched the filters" and EXITS 0 (measured, pnpm 10.28.1). Wired as a
    // plain workflow step, a renamed package silently stops being typechecked.
    const dir = makeRepo(
      { ...AUTH, alpha: true },
      'echo "No projects matched the filters in \\"/repo\\""; exit 0'
    );
    const { code, out } = run(dir);
    expect(out).toContain('matched NO package');
    expect(code).toBe(1);
  });

  it('fails when an app’s typecheck fails', () => {
    const { code, out } = run(makeRepo({ ...AUTH, alpha: true }, 'exit 1'));
    expect(out).toContain('alpha: typecheck failed');
    expect(code).toBe(1);
  });

  it('collects every failure instead of stopping at the first app', () => {
    // Sequential workflow steps abort the job at the first red app, so a shared type change
    // that breaks four of them reports one. This is the difference.
    const { code, out } = run(makeRepo({ ...AUTH, alpha: true, beta: true }, 'exit 1'));
    expect(out).toContain('2 of 2 app(s) failed typecheck');
    expect(out).toContain('alpha:');
    expect(out).toContain('beta:');
    expect(code).toBe(1);
  });

  it('refuses to report success when it discovers no apps', () => {
    // A zero that reads as a pass is the whole failure class. Only `auth` has a typecheck
    // script here, and it is excluded, so the target set is empty.
    const { code, out } = run(makeRepo({ ...AUTH, alpha: false }, 'exit 0'));
    expect(out).toContain('Refusing to report success');
    expect(code).toBe(2);
  });

  it('picks up a newly added app with no edit to the workflow', () => {
    // The hole reopens the moment someone adds an app to a hardcoded list they did not know
    // about. The ledger is read from disk, so it cannot go stale that way.
    const { code, out } = run(makeRepo({ ...AUTH, alpha: true, brandnew: true }, 'exit 0'));
    expect(out).toContain('Typechecking 2 app(s): alpha, brandnew');
    expect(code).toBe(0);
  });

  it('hard-fails on a stale exclusion rather than silently un-gating', () => {
    // If `auth` is fixed or removed but the EXCLUDED entry survives, that entry is a lie.
    // Failing loudly is what stops an app quietly leaving the gate.
    const { code, out } = run(makeRepo({ alpha: true }, 'exit 0'));
    expect(out).toContain('no longer has a typecheck script');
    expect(code).toBe(2);
  });

  it('excludes auth while still checking everything else', () => {
    const { code, out } = run(makeRepo({ ...AUTH, alpha: true }, 'exit 0'));
    expect(out).toContain('Typechecking 1 app(s): alpha');
    expect(out).toContain('Skipping auth');
    expect(code).toBe(0);
  });
});
