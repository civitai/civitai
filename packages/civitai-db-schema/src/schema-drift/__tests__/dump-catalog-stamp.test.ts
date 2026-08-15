import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runTsxCli, type CliRun } from './support/tsx-cli';
import type { DbCatalog } from '../types';

/**
 * Tests for the PRODUCER of `capturedAt` — `drift --dump-catalog`.
 *
 * WHY THIS FILE EXISTS. The staleness signal has two halves: `snapshotAge` in `gate.ts`
 * consumes the stamp, and this command writes it. The consumer was exhaustively tested and
 * the producer was not tested at all, so mutating the stamp expression to
 * `catalog.capturedAt` — which makes a fresh capture carry NO date, silently defeating the
 * whole signal — survived the entire suite with PASS=44 FAIL=0.
 *
 * The one assertion that touched the stamp only checked that the committed FIXTURE has one,
 * and that value is a hand-written midnight instant this command would never emit. Asserting
 * a property of a checked-in file says nothing about the code that is supposed to produce it.
 * That is the isolation seam: two halves, each individually correct, and no test that builds
 * the state where they meet.
 *
 * These drive the real entry point as a process, so they exercise the actual command an
 * operator runs after a recapture.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = join(here, '../../..');
const cli = join(packageRoot, 'src/schema-drift/cli.ts');
const snapshot = join(here, 'fixtures/catalog-production-2026-08-03.json');

async function dump(args: string[]): Promise<CliRun> {
  return runTsxCli(cli, ['--dump-catalog', ...args], {
    cwd: packageRoot,
    // Every case here is --catalog driven. An inherited DATABASE_URL must never be
    // reachable from a test, and this command would otherwise try to connect.
    env: { ...process.env, DATABASE_URL: '' },
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe('drift --dump-catalog stamps capturedAt', { timeout: 60_000 }, () => {
  let dir: string;
  let undated: string;
  let dated: string;
  const PRE_EXISTING = '2020-01-02T03:04:05.678Z';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dump-catalog-stamp-'));
    const catalog = JSON.parse(readFileSync(snapshot, 'utf8')) as DbCatalog;

    const stripped = { ...catalog };
    delete stripped.capturedAt;
    undated = join(dir, 'undated.json');
    writeFileSync(undated, JSON.stringify(stripped));

    dated = join(dir, 'dated.json');
    writeFileSync(dated, JSON.stringify({ ...catalog, capturedAt: PRE_EXISTING }));
  });

  it('the undated input really has no stamp (positive control on the two tests below)', () => {
    // Without this, an input that already carried a date would make "the output has a date"
    // pass with the producer deleted.
    const input = JSON.parse(readFileSync(undated, 'utf8')) as DbCatalog;
    expect(input.capturedAt).toBeUndefined();
    expect(input.columns.length).toBeGreaterThan(0);
  });

  it('writes a capturedAt when the input has none', async () => {
    const before = Date.now();
    const result = await dump(['--catalog', undated]);
    const after = Date.now();
    expect(result.code).toBe(0);

    const output = JSON.parse(result.stdout) as DbCatalog;
    expect(output.capturedAt).toBeTruthy();

    // Not merely "a string": a real instant, from THIS run. A stamp copied from somewhere
    // else, or a hardcoded constant, fails here.
    const stamped = Date.parse(output.capturedAt as string);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);
  });

  it('preserves an existing capturedAt instead of refreshing it', async () => {
    // The date belongs to the CAPTURE, not to the re-dump. Refreshing it on every pass
    // through the tool would let a stale snapshot launder itself young — which is precisely
    // the signal the field exists to carry.
    const result = await dump(['--catalog', dated]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as DbCatalog).capturedAt).toBe(PRE_EXISTING);
  });

  it('emits the catalog unchanged apart from the stamp', async () => {
    const result = await dump(['--catalog', dated]);
    const output = JSON.parse(result.stdout) as DbCatalog;
    const input = JSON.parse(readFileSync(dated, 'utf8')) as DbCatalog;
    expect(output).toEqual(input);
  });

  it('refuses to dump a catalog its own sanity check would reject', async () => {
    // `assertCatalogSanity` used to run AFTER the --dump-catalog return, so the recapture
    // command the STALE message recommends could happily emit a catalog the very next
    // `drift` run would reject. Deleting the call, or moving it back behind the return, both
    // survived the whole suite — the fix worked and a straight revert was invisible. This is
    // the regression coverage for the move itself.
    //
    // The motivating read: `SELECT a.attnotnull notnull` parses as the postfix IS NOT NULL
    // operator and returns a constant true for every column.
    const uniform = join(dir, 'uniform-notnull.json');
    const broken = JSON.parse(readFileSync(snapshot, 'utf8')) as DbCatalog;
    for (const column of broken.columns) column.notNull = true;
    writeFileSync(uniform, JSON.stringify(broken));

    const result = await dump(['--catalog', uniform]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/all \d+ columns report notNull=true/);
    // and it must not have emitted the catalog anyway
    expect(result.stdout).toBe('');
  });

  it('emits indented JSON, so a re-dump of the committed snapshot is a zero-line diff', async () => {
    // The format is load-bearing, not cosmetic. Single-line output made a content-identical
    // re-dump of the committed fixture a 21,522-line diff — and the gate's own STALE message
    // tells the operator to run this exact command.
    const result = await dump(['--catalog', snapshot]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(readFileSync(snapshot, 'utf8'));
    expect(result.stdout.split('\n').length).toBeGreaterThan(1000);
  });
});
