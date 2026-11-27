import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');
const GATE_MODULE = 'lib/server/image-gate.ts';

/** A query on "KnightsImageGate" written by hand: SQL `FROM "KnightsImageGate"` or Kysely `selectFrom('KnightsImageGate')`. */
const RAW_GATE_READ = /\bFROM\s+"KnightsImageGate"|selectFrom\(\s*['"`]KnightsImageGate\b/i;

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Files outside the gate module that read the gate by hand. */
function rawGateReaders(files: { path: string; source: string }[]): string[] {
  return files
    .filter(({ path }) => path !== GATE_MODULE)
    .filter(({ source }) => RAW_GATE_READ.test(withoutComments(source)))
    .map(({ path }) => path);
}

const appFiles = () =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(ts|svelte)$/.test(path) && !/\.(test|spec)\.ts$/.test(path))
    .filter((path) => !path.startsWith('test/'))
    .map((path) => ({
      path: relative(SRC, join(SRC, path)),
      source: readFileSync(join(SRC, path), 'utf8'),
    }));

describe('reads of "KnightsImageGate"', () => {
  it('go through imageGate() alone, which keeps each read a per-image subplan', () => {
    const files = appFiles();
    expect(files.some(({ path }) => path === GATE_MODULE)).toBe(true);
    expect(rawGateReaders(files)).toEqual([]);
  });

  it('flags a hand-written read (the check above can fail)', () => {
    expect(
      rawGateReaders([
        {
          path: 'lib/server/somewhere.ts',
          source: 'sql`AND EXISTS (SELECT 1 FROM "KnightsImageGate" g WHERE g."imageId" = img.id)`',
        },
        { path: 'lib/server/kysely.ts', source: "db.selectFrom('KnightsImageGate as g')" },
        { path: 'lib/server/comment.ts', source: '/** reads from "KnightsImageGate" */' },
      ])
    ).toEqual(['lib/server/somewhere.ts', 'lib/server/kysely.ts']);
  });
});
