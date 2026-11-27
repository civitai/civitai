import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');
const GATE_MODULE = 'lib/server/image-gate.ts';
const ALLOWED = new Set([
  // Batch LEFT JOIN on a LIMIT-n CTE, not an EXISTS; its plan is tracked separately.
  'lib/server/conversion/verdict-labels.ts',
]);

/** A query on "KnightsImageGate" written by hand: SQL `FROM`/`JOIN "KnightsImageGate"`, or Kysely `selectFrom`/`*Join('KnightsImageGate')`. */
const RAW_GATE_READ =
  /\b(FROM|JOIN)\s+"KnightsImageGate"|(selectFrom|[jJ]oin)\(\s*['"`]KnightsImageGate\b/i;

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Files outside the gate module that read the gate by hand. */
function rawGateReaders(files: { path: string; source: string }[]): string[] {
  return files
    .filter(({ path }) => path !== GATE_MODULE && !ALLOWED.has(path))
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
        {
          path: 'lib/server/joined.ts',
          source: 'sql`LEFT JOIN "KnightsImageGate" g ON g."imageId" = b.id`',
        },
        {
          path: 'lib/server/kysely-join.ts',
          source: "qb.leftJoin('KnightsImageGate as g', 'g.imageId', 'i.imageId')",
        },
        { path: 'lib/server/comment.ts', source: '/** reads from "KnightsImageGate" */' },
      ])
    ).toEqual([
      'lib/server/somewhere.ts',
      'lib/server/kysely.ts',
      'lib/server/joined.ts',
      'lib/server/kysely-join.ts',
    ]);
  });

  it('allows only files that still read the gate by hand', () => {
    const files = appFiles();
    for (const path of ALLOWED) {
      const file = files.find((f) => f.path === path);
      expect(file && RAW_GATE_READ.test(withoutComments(file.source))).toBe(true);
    }
  });
});
