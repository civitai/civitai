import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdsUploadKeyText } from '@civitai/db-queries/profile-picture-clear';

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const ADD = readFileSync(
  path.join(MIGRATIONS, '20261119180000_user_image_no_upload_key/migration.sql'),
  'utf8'
);
const VALIDATE = readFileSync(
  path.join(MIGRATIONS, '20261119180100_validate_user_image_no_upload_key/migration.sql'),
  'utf8'
);
const KEY = '3f6e2a10-9b4c-4d7e-8a21-6c0b5d9e1f42';

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  await pg.exec('CREATE TABLE "User" (id int PRIMARY KEY, image text, username text)');
});
afterEach(() => pg.close());

const setImage = (id: number, image: string | null) =>
  pg.query('INSERT INTO "User" (id, image) VALUES ($1, $2)', [id, image]);

describe('the User.image upload-key constraint', () => {
  it('is the shared key rule, word for word', () => {
    expect(ADD).toContain(`CHECK (image IS NULL OR NOT ${holdsUploadKeyText('image')}) NOT VALID`);
  });

  it('🔴 refuses an upload key in any form the rule reads, once added', async () => {
    await pg.exec(ADD);
    for (const [id, image] of [
      [1, KEY],
      [2, KEY.toUpperCase()],
      [3, `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY.replace(/-/g, '%2D')}/width=96`],
    ] as const)
      await expect(setImage(id, image)).rejects.toThrow(/User_image_no_upload_key/);
  });

  it('accepts NULL and an avatar url with no key (control)', async () => {
    await pg.exec(ADD);
    await setImage(1, null);
    await setImage(2, 'https://avatars.githubusercontent.com/u/1?v=4');
    await setImage(3, 'https://cdn.discordapp.com/avatars/123456789/a1b2c3d4e5f6.png');
    const { rows } = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM "User"');
    expect(rows[0].n).toBe(3);
  });

  it('🔴 will not be added while a row still holds a key', async () => {
    await setImage(1, KEY);
    await expect(pg.exec(ADD)).rejects.toThrow(/run the clean-up first/);
    await pg.exec('ROLLBACK');
    const { rows } = await pg.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'User_image_no_upload_key'`
    );
    expect(rows).toHaveLength(0);
  });

  it('validates after it is added, and refuses to run without it', async () => {
    await expect(pg.exec(VALIDATE)).rejects.toThrow(/apply 20261119180000 first/);
    await setImage(1, 'https://avatars.githubusercontent.com/u/1?v=4');
    await pg.exec(ADD);
    await pg.exec(VALIDATE);
    const { rows } = await pg.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'User_image_no_upload_key'`
    );
    expect(rows).toEqual([{ convalidated: true }]);
  });
});
