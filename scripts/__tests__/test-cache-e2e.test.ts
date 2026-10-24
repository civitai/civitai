import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { recordsFor } from '../test-cache/core.mjs';

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

/** The entries of the one record for `rel`. */
function entriesOf(cacheDir: string, rel: string): string[] {
  const found = (recordsFor as (d: string, p: string, t: string) => { entries: string[] }[])(
    cacheDir,
    'unit-e2e',
    rel
  );
  expect(found).toHaveLength(1);
  return found[0].entries;
}

describe('the cache, run for real', () => {
  it('records a passing file, then skips it when nothing changed', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'test-cache-e2e-'));

    const cold = runOnce(cacheDir);
    expect(cold.status).toBe(0);
    // Both fixtures, one of which is a happy-dom file: that one resolves a node builtin to a vite
    // virtual id, and a key that treats such an id as a path records nothing for it.
    expect({ recorded: cold.last.recorded, notRecorded: cold.last.notRecorded }).toEqual({
      recorded: 9,
      notRecorded: {},
    });

    // Age every record, so a hit that refreshes it is visible: eviction goes by mtime, and a record
    // the real sequencer hits must move to the front of that order.
    const recDir = join(cacheDir, 'rec');
    const old = Date.now() / 1000 - 86_400;
    const files = readdirSync(recDir).flatMap((id) =>
      readdirSync(join(recDir, id)).map((n) => join(recDir, id, n))
    );
    expect(files).toHaveLength(9);
    for (const f of files) utimesSync(f, old, old);
    // A second record beside one of them that matches nothing: only the record that answered the
    // lookup may be refreshed, not whichever sorts first or every record in the directory.
    const decoy = join(dirname(files[0]!), 'decoy.json');
    writeFileSync(
      decoy,
      JSON.stringify({ ...JSON.parse(readFileSync(files[0]!, 'utf8')), key: 'decoy' })
    );
    utimesSync(decoy, old + 60, old + 60);

    const warm = runOnce(cacheDir);
    expect(warm.status).toBe(0);
    expect({ ran: warm.last.ran, skipped: warm.last.skipped }).toEqual({ ran: 0, skipped: 9 });
    // CIVITAI_TEST_CACHE_SAMPLE: '0' is load-bearing here: a sampled re-run rewrites its record,
    // which would refresh the mtime without markHit.
    expect(files.filter((f) => statSync(f).mtimeMs / 1000 > old + 3600)).toHaveLength(9);
    expect(statSync(decoy).mtimeMs / 1000).toBeLessThan(old + 3600);
  }, 300_000);

  // Both files import heavy.ts, so the run's shared graph carries heavy-dep.ts under it. Only the
  // file that loaded heavy.ts for real may be keyed on heavy-dep.ts: the other replaced heavy.ts
  // with a factory, and before the fix it was keyed on the sibling's subtree too. The real file's
  // entry is the control that heavy-dep.ts was in the graph at all.
  it('keys a factory-mocked module without the subtree a sibling loaded under it', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'test-cache-e2e-'));
    expect(runOnce(cacheDir).status).toBe(0);

    const dir = 'scripts/test-cache/__e2e__';
    const real = entriesOf(cacheDir, `${dir}/heavy-real.e2e.ts`);
    const mocked = entriesOf(cacheDir, `${dir}/heavy-mocked.e2e.ts`);
    expect(real).toEqual(expect.arrayContaining([`${dir}/heavy.ts`, `${dir}/heavy-dep.ts`]));
    expect(mocked).toContain(`${dir}/heavy.ts`);
    expect(mocked).not.toContain(`${dir}/heavy-dep.ts`);

    // Each of these loaded heavy-dep.ts in a way that leaves no plain "evaluated" mark behind:
    // vi.resetModules() after the test, a spy that runs the real module under a `mock:` id, a
    // factory that calls importOriginal, and a module that threw partway through loading.
    for (const file of ['heavy-reset', 'heavy-spy', 'heavy-original', 'throws']) {
      expect(entriesOf(cacheDir, `${dir}/${file}.e2e.ts`)).toContain(`${dir}/heavy-dep.ts`);
    }
    // And the reset did not just switch the narrowing off: the module it factory-mocks is still
    // keyed without the subtree heavy-real.e2e.ts loaded under it.
    expect(real).toContain(`${dir}/sibling-dep.ts`);
    expect(entriesOf(cacheDir, `${dir}/heavy-reset.e2e.ts`)).not.toContain(`${dir}/sibling-dep.ts`);
  }, 300_000);

  // setup.ts's factory loads factory-dep.ts only in a file that imports the mocked specifier, but
  // the shared graph hangs it under setup.ts for every file. The loading file's entry is the
  // control that it was in the graph at all.
  it('keys a module a setup factory loads only for the file that ran the factory', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'test-cache-e2e-'));
    expect(runOnce(cacheDir).status).toBe(0);

    const dir = 'scripts/test-cache/__e2e__';
    expect(entriesOf(cacheDir, `${dir}/factory-loads.e2e.ts`)).toContain(`${dir}/factory-dep.ts`);
    const other = entriesOf(cacheDir, `${dir}/probe.e2e.ts`);
    expect(other).toContain(`${dir}/setup.ts`);
    expect(other).not.toContain(`${dir}/factory-dep.ts`);
  }, 300_000);
});
