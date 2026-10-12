import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `CIVITAI_SKIP_BUILD_TYPECHECK` turns off `next build`'s own TypeScript pass. Only the PR-preview
 * image build sets it; every other build must keep the check. These cases pin that the default is
 * the CHECKED build, and that only the exact value `'1'` opts out.
 *
 * Reads the real `next.config.mjs` export, re-evaluated per case, rather than scanning its text: a
 * text scan passes on a setting that never reaches the exported object.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const VAR = 'CIVITAI_SKIP_BUILD_TYPECHECK';

async function loadIgnoreBuildErrors(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env[VAR];
  else vi.stubEnv(VAR, value);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = (await import('../../next.config.mjs')).default as any;
  return config.typescript?.ignoreBuildErrors;
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env[VAR];
});

describe('next build type-check opt-out', () => {
  it('type-checks when the variable is unset', async () => {
    expect(await loadIgnoreBuildErrors(undefined)).toBe(false);
  });

  it.each(['', '0', 'true', 'yes', ' 1'])('type-checks when the variable is %j', async (value) => {
    expect(await loadIgnoreBuildErrors(value)).toBe(false);
  });

  it("skips the pass only for exactly '1'", async () => {
    // The positive control: without it, every case above would also pass against a config that
    // ignored the variable entirely and hardcoded `false`.
    expect(await loadIgnoreBuildErrors('1')).toBe(true);
  });
});

describe('the Dockerfile forwards the opt-out without enabling it', () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
  const builderStart = dockerfile.indexOf('AS builder');
  const buildRun = dockerfile.indexOf('pnpm run build', builderStart);

  it('declares an empty-default ARG in the builder stage, before the build runs', () => {
    expect(builderStart).toBeGreaterThan(-1);
    expect(buildRun).toBeGreaterThan(builderStart);
    const declared = dockerfile.indexOf(`ARG ${VAR}=""`, builderStart);
    expect(declared).toBeGreaterThan(builderStart);
    expect(declared).toBeLessThan(buildRun);
  });

  it('never sets it as an ENV or with a non-empty default', () => {
    expect(dockerfile).not.toMatch(new RegExp(`^\\s*ENV\\s+${VAR}`, 'm'));
    expect(dockerfile).not.toMatch(new RegExp(`ARG\\s+${VAR}=(?!"")`));
  });
});
