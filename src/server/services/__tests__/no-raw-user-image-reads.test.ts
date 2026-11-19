import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Raw SQL that reads `User.image` under src/server and src/pages/api goes through
 * `fallbackUserImageColumn` (or its `Of` form), which nulls one naming a held or blocked profile
 * picture. Covers any alias a file gives "User" and an unaliased `SELECT ... image ... FROM "User"`;
 * Prisma and Kysely selects of the column are not raw SQL and are out of its reach.
 */
const ROOT = path.resolve(__dirname, '../../..');
const SCANNED = ['server', 'pages/api'];
const SQL_KEYWORDS = new Set([
  'where',
  'on',
  'join',
  'left',
  'inner',
  'set',
  'order',
  'group',
  'limit',
  'as',
  'using',
  'cross',
]);
const USER_ALIAS = /"User"\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g;
const UNALIASED_SELECT =
  /SELECT\b(?:(?!SELECT\b|FROM\b)[\s\S]){0,400}?(?<![.\w"])image(?![\w"])(?:(?!SELECT\b)[\s\S]){0,400}?FROM\s+"User"(?=\s+(?:WHERE|LIMIT|ORDER)\b|\s*[)`;])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

function rawReads(source: string) {
  const aliases = new Set(['u', 'ju', '"User"']);
  for (const [, name] of source.matchAll(USER_ALIAS))
    if (!SQL_KEYWORDS.has(name.toLowerCase())) aliases.add(name);
  const found: string[] = [];
  for (const name of aliases) {
    const escaped = name.replace(/"/g, '\\"');
    const pattern = new RegExp(`(?<![\\w.])${escaped}\\.(?:"image"|image\\b)`, 'g');
    found.push(...(source.match(pattern) ?? []));
  }
  for (const [match] of source.matchAll(UNALIASED_SELECT))
    found.push(match.replace(/\s+/g, ' ').slice(0, 80));
  return found;
}

describe('raw User.image reads in server SQL', () => {
  it('finds a raw read when one is there', () => {
    expect(rawReads('SELECT u.username, u.image FROM "User" u')).toEqual(['u.image']);
    expect(rawReads(`'image', u."image",`)).toEqual(['u."image"']);
    expect(rawReads('ju.image AS "judgeImage" FROM "User" ju')).toEqual(['ju.image']);
    expect(rawReads('SELECT cu.image FROM x JOIN "User" cu ON cu.id = x."userId"')).toEqual([
      'cu.image',
    ]);
    expect(rawReads('SELECT "User".image FROM "User"')).toHaveLength(1);
    expect(
      rawReads('SELECT id, username, image, "deletedAt"\n FROM "User"\n WHERE id = 1')
    ).toHaveLength(1);
    expect(rawReads('u."imageId", u.imageUrl, i.image FROM "Image" i')).toEqual([]);
    expect(
      rawReads('SELECT u.id, CASE WHEN x THEN NULL ELSE u.image END AS image FROM "User" u')
    ).toEqual(['u.image']);
  });

  it('scans the server tree', () => {
    expect(SCANNED.flatMap((dir) => sourceFiles(path.join(ROOT, dir))).length).toBeGreaterThan(500);
  });

  it('has none', () => {
    const found = SCANNED.flatMap((dir) => sourceFiles(path.join(ROOT, dir))).flatMap((file) =>
      rawReads(readFileSync(file, 'utf8')).map((read) => `${path.relative(ROOT, file)}: ${read}`)
    );
    expect(found).toEqual([]);
  });
});
