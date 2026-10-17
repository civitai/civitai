import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { typecheckAppsGateDecision } from '../typecheck-apps-gate.mjs';

/**
 * `pnpm run typecheck` is the command people reach for and quote as evidence, and the root
 * tsconfig `include` has no `apps/*` entry — so it reported OK over a planted type error in an
 * app (#4832). These cases hold the closing condition for that: a failing app typecheck must
 * make this command exit non-zero.
 *
 * Each case builds a throwaway repo with the real scripts, a STUB `typescript` so the root run
 * is sub-second rather than minutes, and the same FAKE `pnpm` fixture as
 * scripts/__tests__/typecheck-apps.test.ts. The tsc test seam is deliberately NOT used here:
 * that seam turns the apps gate off (it exists to drive the root classifier), which is itself
 * one of the cases below.
 */

const SCRIPTS = resolve(fileURLToPath(new URL('..', import.meta.url)));

let root: string;
let seq = 0;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'typecheck-apps-gate-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A throwaway repo: the real scripts, a stub tsc, a stub apps/ tree, and a fake pnpm on PATH. */
function makeRepo({ apps, pnpmCode }: { apps: string[]; pnpmCode: number }) {
  const dir = join(root, `case-${seq++}`);
  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const f of ['typecheck.mjs', 'typecheck-queue.mjs', 'typecheck-apps-gate.mjs']) {
    cpSync(join(SCRIPTS, f), join(dir, 'scripts', f));
  }
  cpSync(
    join(SCRIPTS, 'ci', 'typecheck-apps.mjs'),
    join(dir, 'scripts', 'ci', 'typecheck-apps.mjs')
  );

  // A clean tsc, resolved the way the wrapper resolves the real one. Keeps the root run honest
  // (no seam) while costing milliseconds.
  mkdirSync(join(dir, 'node_modules', 'typescript', 'lib'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'typescript', 'package.json'),
    JSON.stringify({ name: 'typescript', version: '0.0.0-stub' })
  );
  writeFileSync(join(dir, 'node_modules', 'typescript', 'lib', 'tsc.js'), 'process.exit(0);\n');

  for (const app of apps) {
    mkdirSync(join(dir, 'apps', app), { recursive: true });
    writeFileSync(
      join(dir, 'apps', app, 'package.json'),
      JSON.stringify({ name: `@civitai/${app}`, scripts: { typecheck: 'svelte-check' } })
    );
  }

  const fake = join(dir, 'bin', 'pnpm');
  writeFileSync(
    fake,
    `#!/usr/bin/env node\n` +
      `process.stdout.write('ARGV ' + process.argv.slice(2).join(' ') + '\\n');\n` +
      `process.exit(${pnpmCode});\n`
  );
  chmodSync(fake, 0o755);
  // Windows resolves a bare `pnpm` through PATHEXT, so the extensionless file above is invisible
  // to it; the shim re-enters it through node so both platforms run identical logic.
  writeFileSync(join(dir, 'bin', 'pnpm.cmd'), `@node "%~dp0pnpm" %*\r\n`);
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['scripts/typecheck.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      // `path.delimiter`, not ':' — on Windows a ':'-joined PATH is one nonexistent directory.
      PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
      CI: '',
      GITHUB_ACTIONS: '',
      CIVITAI_TEST_QUEUE: '',
      TYPECHECK_TSC_PATH: '',
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('typecheckAppsGateDecision', () => {
  it('runs the gate for an ordinary local run', () => {
    expect(typecheckAppsGateDecision({}).run).toBe(true);
  });

  it('leaves apps/* to the dedicated CI step', () => {
    // Running them here too would double that work on every CI typecheck.
    expect(typecheckAppsGateDecision({ CI: 'true' }).run).toBe(false);
  });

  it('stays out of the way of the root classifier tests', () => {
    // The stub those cases pass exits like a crashed/clean/erroring tsc and says nothing about
    // apps/*; fanning out to a real svelte-check per app would make each case minutes long.
    expect(typecheckAppsGateDecision({ TYPECHECK_TSC_PATH: '/tmp/stub.mjs' }).run).toBe(false);
  });
});

describe('pnpm run typecheck covers apps/*', () => {
  it('fails when an app typecheck fails, even though the root run is clean', () => {
    // The closing condition of #4832: before this, the command printed OK and exited 0 here.
    const res = run(makeRepo({ apps: ['moderator'], pnpmCode: 1 }));

    expect(res.code).not.toBe(0);
    expect(res.out).toContain('typecheck: OK');
    expect(res.out).toContain('moderator');
    expect(res.out).toContain('an apps/* typecheck failed');
  });

  it('passes when the root run and every app are clean', () => {
    const res = run(makeRepo({ apps: ['moderator', 'auth'], pnpmCode: 0 }));

    expect(res.code).toBe(0);
    expect(res.out).toContain('All 2 app(s) passed typecheck.');
  });

  it('asks pnpm to run each app’s own typecheck script', () => {
    // Answering by exit code alone would leave this blind to a wrong --filter or script name.
    const res = run(makeRepo({ apps: ['moderator'], pnpmCode: 0 }));

    expect(res.out).toContain('ARGV --filter @civitai/moderator run typecheck');
  });

  it('says so, rather than silently skipping, when it leaves apps/* to CI', () => {
    const res = run(makeRepo({ apps: ['moderator'], pnpmCode: 1 }), { CI: 'true' });

    expect(res.code).toBe(0);
    expect(res.out).toContain('apps/* not checked here');
    expect(res.out).not.toContain('ARGV');
  });

  it('does not fan out to apps/* when the root tsc seam is in use', () => {
    const dir = makeRepo({ apps: ['moderator'], pnpmCode: 1 });
    writeFileSync(join(dir, 'stub-tsc.mjs'), 'process.exit(0);\n');

    const res = run(dir, { TYPECHECK_TSC_PATH: join(dir, 'stub-tsc.mjs') });

    expect(res.code).toBe(0);
    expect(res.out).not.toContain('ARGV');
  });
});
