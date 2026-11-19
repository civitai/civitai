import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Another user's `User.image` is served only through `fallbackUserImageColumn` (or its `Of` form),
 * which nulls one naming a held or blocked profile picture. A raw `u.image` read in server SQL
 * skips that, so this fails on any.
 */
const ROOT = path.resolve(__dirname, '../../..');
const SCANNED = ['server', 'pages/api'];
const RAW_USER_IMAGE = /\b(?:u|ju)\.(?:"image"|image\b)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

const rawReads = (source: string) => source.match(RAW_USER_IMAGE) ?? [];

describe('raw User.image reads in server SQL', () => {
  it('finds a raw read when one is there', () => {
    expect(rawReads('SELECT u.username, u.image FROM "User" u')).toEqual(['u.image']);
    expect(rawReads(`'image', u."image",`)).toEqual(['u."image"']);
    expect(rawReads('ju.image AS "judgeImage"')).toEqual(['ju.image']);
    expect(rawReads('u."imageId", u.imageUrl')).toEqual([]);
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
