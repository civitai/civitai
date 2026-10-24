import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Model.lastVersionAt is timestamp(3), so a bare NOW() is rounded to the millisecond — UP about half
// the time. sync_model_to_metric treats a value later than NOW() as a future date and writes NULL to
// ModelMetric.lastVersionAt, which drops the model from the Newest feed.

const SRC = join(__dirname, '../../..');
const BARE_NOW = /"lastVersionAt"\s*=\s*now\(\)/i;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield path;
  }
}

describe('lastVersionAt writes', () => {
  it('never set lastVersionAt to a bare NOW()', () => {
    const offenders = [...sourceFiles(SRC)].filter((file) =>
      BARE_NOW.test(readFileSync(file, 'utf8'))
    );

    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });

  it('matches the pattern it is meant to catch', () => {
    expect(BARE_NOW.test('SET "lastVersionAt" = NOW()')).toBe(true);
    expect(BARE_NOW.test(`SET "lastVersionAt" = date_trunc('milliseconds', NOW())`)).toBe(false);
  });
});
