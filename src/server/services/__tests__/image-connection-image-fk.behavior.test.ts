import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const read = (dir: string) =>
  readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8')
    // psql meta-commands (\set ON_ERROR_STOP on) are not SQL; PGlite runs the rest.
    .replace(/^\\set .*$/m, '');
const ADD = read('20271122130000_image_connection_image_fk');
const VALIDATE = read('20271122130100_validate_image_connection_image_fk');

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  // As production: no foreign key, so connections can outlive their image.
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY);
    CREATE TABLE "ImageConnection" (
      "imageId" int NOT NULL, "entityId" int NOT NULL, "entityType" text NOT NULL,
      PRIMARY KEY ("imageId", "entityType", "entityId")
    );
    INSERT INTO "Image" VALUES (1), (2);
    INSERT INTO "ImageConnection" VALUES (1, 10, 'Article'), (2, 10, 'Bounty'), (3, 11, 'Bounty');
  `);
});
const connections = async () =>
  (
    await pg.query<{ imageId: number }>('SELECT "imageId" FROM "ImageConnection" ORDER BY 1')
  ).rows.map((r) => r.imageId);

describe('the ImageConnection image foreign key migrations', () => {
  it('delete the orphan, keep the rest, and validate', async () => {
    await pg.exec(ADD);
    expect(await connections()).toEqual([1, 2]);
    await pg.exec(VALIDATE);
    const { rows } = await pg.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'ImageConnection_imageId_fkey'`
    );
    expect(rows).toEqual([{ convalidated: true }]);
  });

  it('then an image delete removes its connections, and an orphan cannot be written', async () => {
    await pg.exec(ADD + VALIDATE);
    await pg.exec('DELETE FROM "Image" WHERE id = 1');
    expect(await connections()).toEqual([2]);
    await expect(pg.exec(`INSERT INTO "ImageConnection" VALUES (9, 1, 'Bounty')`)).rejects.toThrow(
      /foreign key/
    );
  });

  it('validation refuses to run without the key', async () => {
    await expect(pg.exec(VALIDATE)).rejects.toThrow(/apply 20271122130000 first/);
  });
});
