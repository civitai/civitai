import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The one test that runs the cache for real: vitest, the real sequencer, reporter and fs tracker,
 * over a one-file fixture — twice. Unit tests with fake vitest objects stayed green through two
 * regressions that made the cache record NOTHING on the real repo, because the fakes modelled
 * neither the snapshot probe every file makes nor a setup closure mentioning 'cluster'. This is
 * what reddens when the cache is inert.
 */
const repo = resolve(__dirname, '../..');
const vitestBin = join(repo, 'node_modules/vitest/vitest.mjs');
const config = 'scripts/test-cache/__e2e__/vitest.e2e.config.mts';
const reporter = join(repo, 'scripts/test-cache/reporter.mjs');

function runOnce(cacheDir: string) {
  const r = spawnSync(
    process.execPath,
    [vitestBin, 'run', '--config', config, '--reporter=default', `--reporter=${reporter}`],
    {
      cwd: repo,
      encoding: 'utf8',
      // Bounded: a wedged child fails this test with a timeout message, never hangs the runner.
      timeout: 120_000,
      env: {
        ...process.env,
        CI: '',
        CIVITAI_TEST_CACHE: 'on',
        CIVITAI_TEST_CACHE_DIR: cacheDir,
        CIVITAI_TEST_CACHE_SAMPLE: '0',
      },
    }
  );
  const ledger = readFileSync(join(cacheDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
  return { status: r.status, last: JSON.parse(ledger[ledger.length - 1]) };
}

describe('the cache, run for real', () => {
  it('records a passing file, then skips it when nothing changed', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'test-cache-e2e-'));

    const cold = runOnce(cacheDir);
    expect(cold.status).toBe(0);
    // Both fixtures, one of which is a happy-dom file: that one resolves a node builtin to a vite
    // virtual id, and a key that treats such an id as a path records nothing for it.
    expect({ recorded: cold.last.recorded, notRecorded: cold.last.notRecorded }).toEqual({
      recorded: 2,
      notRecorded: {},
    });

    const warm = runOnce(cacheDir);
    expect(warm.status).toBe(0);
    expect({ ran: warm.last.ran, skipped: warm.last.skipped }).toEqual({ ran: 0, skipped: 2 });
  }, 300_000);
});
