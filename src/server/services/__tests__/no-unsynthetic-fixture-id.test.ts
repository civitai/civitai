import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 Fails when a CSAM-path test or fixture holds an id-sized number outside the synthetic range.
 * Ids in these fixtures come from `SYNTHETIC_MIN`..`SYNTHETIC_MAX`, so a fixture never carries the
 * id of a real account or record. Small ids (under 10 000) and round numbers (durations, sizes)
 * pass; a genuine non-id constant goes in `BASELINE` with its file.
 */

const REPO = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'scripts', 'apps', 'packages'].map((dir) => path.join(REPO, dir));

const SYNTHETIC_MIN = 990_000_000;
const SYNTHETIC_MAX = 990_999_999;

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mts', '.mjs', '.svelte', '.sql', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', '.next', 'build', 'dist', '.turbo']);

/** Non-synthetic literals already in scope when the guard landed, by file. Shrink only. */
const BASELINE: Record<string, string[]> = {
  'src/server/services/__tests__/csam-archive-backpressure.test.ts': [
    '202020',
    '303030',
    '404040',
    '505050',
    '606060',
    '707070',
    '717171',
    '727272',
    '808080',
    '909090',
    '919191',
  ],
  'src/server/services/__tests__/csam-archive-stream-upload.test.ts': [
    '12345',
    '909090',
    '2654435761', // a hash multiplier, not an id
  ],
  'src/server/services/__tests__/csam-original-image.test.ts': ['12345'],
  'src/server/services/__tests__/csam-archive-scratch-sweep.test.ts': ['11111111'],
  'src/server/services/__tests__/csam-send-scratch-sweep.test.ts': [
    '11111111',
    '22222222',
    '33333333',
    '44444444',
  ],
  'apps/moderator/src/lib/server/__tests__/csam-flag-clear.pglite.test.ts': ['99999999999'],
  'apps/moderator/src/routes/admin/__tests__/csam-flag-release-actions.test.ts': [
    '1234567890',
    '99999999999',
  ],
};

function inScope(repoPath: string): boolean {
  if (!/csam/i.test(repoPath)) return false;
  return (
    /\.test\.[cm]?[jt]sx?$/.test(repoPath) ||
    /\.fixture\.[a-z]+$/.test(repoPath) ||
    /\/_{0,2}fixtures?_{0,2}\//.test(repoPath)
  );
}

/** Integer literals, bare or as an all-digit string, that look like an id and are not synthetic. */
function unsyntheticIds(source: string): string[] {
  const found: string[] = [];
  const literal = /(?<![\w.$#/:\\-])(['"`]?)([1-9][0-9_]*[0-9])\1(?![\w.])/g;
  for (const match of source.matchAll(literal)) {
    const digits = match[2].replace(/_/g, '');
    if (!/^\d+$/.test(digits) || digits.length > 12) continue;
    if (match[1] && digits.length < 6) continue; // quoted codes such as SQLSTATE '23505'
    const n = Number(digits);
    if (n < 10_000 || n % 1000 === 0) continue;
    if (n >= SYNTHETIC_MIN && n <= SYNTHETIC_MAX) continue;
    found.push(digits);
  }
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const toRepoPath = (file: string) => path.relative(REPO, file).split(path.sep).join('/');
const files = ROOTS.flatMap((root) => walk(root))
  .map((full) => ({ full, repoPath: toRepoPath(full) }))
  .filter(({ repoPath }) => inScope(repoPath));

describe('🔴 CSAM-path test fixtures use synthetic ids', () => {
  it('the scan reached the CSAM tests', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.map((f) => f.repoPath)).toContain(
      'apps/moderator/src/lib/server/__tests__/csam-archive-run.pglite.test.ts'
    );
  });

  it.each([
    [
      'a user id and a report id as query params',
      `db.query(START, ['report', 4821937, null, 31877]);`,
    ],
    ['an object key', `const report = { id: 52817, userId: 1834502 };`],
    ['a SQL insert', `INSERT INTO "CsamReport" ("id", "userId") VALUES (52817, 1834502);`],
    ['an all-digit string', `const user = { id: '1834502' };`],
    ['a separated literal', `userId: 1_834_502,`],
  ])('flags %s', (_, source) => {
    expect(unsyntheticIds(source).length).toBeGreaterThan(0);
  });

  it.each([
    ['synthetic ids', `db.query(START, ['report', 990000002, null, 990000001]);`],
    ['small ids', `const report = { id: 1, userId: 42, imageId: 9999 };`],
    ['round numbers', `const timeoutMs = 60000; const bytes = 1_048_576_000;`],
    ['decimals and dotted versions', `const v = 'v0.2.10'; const ratio = 0.123456;`],
    ['identifiers and hex', `const user12345 = 0x1f2e3d4c; const k = 'abc12345';`],
    ['dates and SQLSTATE strings', `'2026-11-14'; code === '23505';`],
  ])('passes %s', (_, source) => {
    expect(unsyntheticIds(source)).toEqual([]);
  });

  it('each in-scope file holds only synthetic ids, beyond its baseline', () => {
    const offenders: string[] = [];
    for (const { full, repoPath } of files) {
      const allowed = new Set(BASELINE[repoPath] ?? []);
      const extra = [...new Set(unsyntheticIds(readFileSync(full, 'utf8')))].filter(
        (n) => !allowed.has(n)
      );
      if (extra.length) offenders.push(`${repoPath}: ${extra.join(', ')}`);
    }
    expect(
      offenders,
      `Use ids from ${SYNTHETIC_MIN}..${SYNTHETIC_MAX} in these fixtures (small ids under 10000 also pass).`
    ).toEqual([]);
  });

  it('every baseline entry is still in its file', () => {
    const stale: string[] = [];
    for (const [repoPath, literals] of Object.entries(BASELINE)) {
      const present = new Set(unsyntheticIds(readFileSync(path.join(REPO, repoPath), 'utf8')));
      for (const n of literals) if (!present.has(n)) stale.push(`${repoPath}: ${n}`);
    }
    expect(stale, 'Remove these from BASELINE').toEqual([]);
  });
});
