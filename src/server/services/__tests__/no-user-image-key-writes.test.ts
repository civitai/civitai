import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `User.image` never receives an upload key: only the profile save writes a value into it, and the
 * save refuses any value `keysIn` finds a key in. Every other write sets it to NULL. This finds a new
 * writer at review time: a raw `UPDATE "User" SET ... image = <not NULL>` or `INSERT INTO "User"`
 * naming the column, a Kysely `updateTable('User')` / `insertInto('User')` setting it, and a Prisma
 * `user.update…` / `updateUserById` call passing it, outside the profile save.
 */
const REPO = path.resolve(__dirname, '../../../..');
const SCANNED = [
  'src/server',
  'src/pages/api',
  'packages/civitai-db-queries/src',
  'apps/moderator/src',
  'apps/auth/src',
];
// The profile save: refuses a key in `data.image` before it writes (user.controller.ts).
const ALLOWED = new Set(['src/server/controllers/user.controller.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory())
      return entry === '__tests__' || entry === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|svelte)$/.test(full) && !/\.test\.ts$/.test(full) ? [full] : [];
  });
}

const RAW_UPDATE =
  /UPDATE\s+(?:public\.)?"User"(?:\s+(?:AS\s+)?\w+)?\s+SET\b([\s\S]{0,600}?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|`)/gi;
const RAW_SET_IMAGE = /(?:^|,|\bSET\b|\s)(?:\w+\.)?"?image"?\s*=(?!\s*NULL\b)/i;
const RAW_INSERT = /INSERT\s+INTO\s+(?:public\.)?"User"\s*\(([^)]*)\)/gi;
const KYSELY =
  /\.(?:updateTable|insertInto)\(\s*['"]User['"]\s*\)[\s\S]{0,400}?\.(?:set|values)\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
const PRISMA =
  /\.user\.(?:update|updateMany|upsert|create|createMany)\(\s*\{([\s\S]{0,800}?)\}\s*\)/g;
const UPDATE_USER_BY_ID = /\bupdateUserById\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
const IMAGE_KEY = /(?<![\w.])image\s*(?::(?!\s*null\b)|,|\}|$)/;

export function imageWrites(source: string): string[] {
  const found: string[] = [];
  for (const [match, set] of source.matchAll(RAW_UPDATE))
    if (RAW_SET_IMAGE.test(` ${set}`)) found.push(match.replace(/\s+/g, ' ').slice(0, 80));
  for (const [match, columns] of source.matchAll(RAW_INSERT))
    if (/(?<![\w"])"?image"?(?![\w"])/.test(columns))
      found.push(match.replace(/\s+/g, ' ').slice(0, 80));
  for (const pattern of [KYSELY, PRISMA, UPDATE_USER_BY_ID])
    for (const [match, body] of source.matchAll(pattern))
      if (IMAGE_KEY.test(body)) found.push(match.replace(/\s+/g, ' ').slice(0, 80));
  return found;
}

describe('writes of User.image', () => {
  it('finds a write that can store a value', () => {
    expect(
      imageWrites('UPDATE "User" u SET image = picture.url, meta = x FROM picture WHERE')
    ).toHaveLength(1);
    expect(
      imageWrites('UPDATE "User" SET "deletedAt" = now(), image = $1 WHERE id = 1')
    ).toHaveLength(1);
    expect(imageWrites('INSERT INTO "User" (id, username, image) VALUES (1, 2, 3)')).toHaveLength(
      1
    );
    expect(
      imageWrites(`db.updateTable('User').set({ image: url }).where('id', '=', 1)`)
    ).toHaveLength(1);
    expect(
      imageWrites(`db.insertInto('User').values({ email, image }).returning('id')`)
    ).toHaveLength(1);
    expect(
      imageWrites('dbWrite.user.update({ where: { id }, data: { image: input.image } })')
    ).toHaveLength(1);
    expect(imageWrites('updateUserById({ id, data: { ...data, image, username } })')).toHaveLength(
      1
    );
  });

  it('passes a write that only empties it, and writes of other columns (control)', () => {
    expect(imageWrites('UPDATE "User" u SET image = NULL FROM held WHERE u.id = held.id')).toEqual(
      []
    );
    expect(
      imageWrites('UPDATE "User" SET "deletedAt" = now(),\n image = NULL,\n email = NULL WHERE')
    ).toEqual([]);
    expect(imageWrites('UPDATE "User" SET "imageId" = 1, "profilePictureId" = 2 WHERE')).toEqual(
      []
    );
    expect(
      imageWrites(`db.insertInto('User').values({ email, image: null }).returning('id')`)
    ).toEqual([]);
    expect(imageWrites(`db.updateTable('User').set({ muted: true }).where('id', '=', 1)`)).toEqual(
      []
    );
    expect(
      imageWrites('dbWrite.user.update({ where: { id }, data: { profileImage: x } })')
    ).toEqual([]);
  });

  it('scans every tree that writes "User"', () => {
    const files = SCANNED.flatMap((dir) => sourceFiles(path.join(REPO, dir)));
    expect(files.length).toBeGreaterThan(1000);
    expect(files.map((file) => path.relative(REPO, file))).toContain(
      'packages/civitai-db-queries/src/profile-picture-clear.db.ts'
    );
  });

  it('has none outside the profile save', () => {
    const found = SCANNED.flatMap((dir) => sourceFiles(path.join(REPO, dir)))
      .map((file) => path.relative(REPO, file).split(path.sep).join('/'))
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) =>
        imageWrites(readFileSync(path.join(REPO, file), 'utf8')).map((write) => `${file}: ${write}`)
      );
    expect(found).toEqual([]);
  });
});
