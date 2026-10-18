import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * An in-process Postgres holding the tables `app_listing_red_media` references, so the split
 * service's raw SQL runs against the REAL migration a human applies — or, before
 * {@link SplitDb.applyMigration}, against a database where the table is absent.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261108120000_app_listing_red_media/migration.sql'
);

export type SplitDb = {
  db: PGlite;
  applyMigration: () => Promise<void>;
  seed: (args: {
    listingIds?: string[];
    images?: Record<number, number>;
    users?: number[];
  }) => Promise<void>;
  /** A `$queryRaw`/`$executeRaw` pair backed by this database. */
  raw: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
  stamp: (appListingId: string) => Promise<{ at: string | null; by: number | null } | null>;
  /**
   * Route a mocked Prisma client's raw SQL here when it names the split table or the face read;
   * everything else keeps answering `fallback`.
   */
  route: (
    client: {
      $queryRaw: { mockImplementation: (f: RawFn) => unknown };
      $executeRaw: { mockImplementation: (f: RawFn) => unknown };
    },
    fallback?: { queryRaw?: RawFn; executeRaw?: RawFn }
  ) => void;
};

type RawFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

const isSplitSql = (strings: TemplateStringsArray, values: unknown[]) => {
  const text = Prisma.sql(strings, ...values).text;
  return text.includes('app_listing_red_media') || /FROM "Image" WHERE id IN/.test(text);
};

export async function createSplitDb(): Promise<SplitDb> {
  const db = new PGlite();
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" (id INT PRIMARY KEY);
    CREATE TABLE "Image" (id INT PRIMARY KEY, "nsfwLevel" INT NOT NULL DEFAULT 0);
    CREATE TABLE "app_listings" (id TEXT PRIMARY KEY, content_rating TEXT);
  `);
  const pg = pgliteRaw(db);
  const raw = {
    $queryRaw: pg.queryRaw,
    $executeRaw: pg.executeRaw,
  } as unknown as Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
  const rawQuery = pg.queryRaw as RawFn;
  const rawExecute = pg.executeRaw as RawFn;
  return {
    db,
    raw,
    applyMigration: async () => {
      await db.exec(readFileSync(MIGRATION, 'utf8'));
    },
    seed: async ({ listingIds = [], images = {}, users = [] }) => {
      for (const id of listingIds)
        await db.query(`INSERT INTO app_listings (id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
      for (const [id, level] of Object.entries(images))
        await db.query(
          `INSERT INTO "Image" (id, "nsfwLevel") VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET "nsfwLevel" = EXCLUDED."nsfwLevel"`,
          [Number(id), level]
        );
      for (const id of users)
        await db.query(`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    },
    stamp: async (appListingId) => {
      const { rows } = await db.query<{ at: string | null; by: number | null }>(
        `SELECT media_split_approved_at::text AS at, media_split_approved_by AS by
         FROM app_listing_red_media WHERE app_listing_id = $1`,
        [appListingId]
      );
      return rows[0] ?? null;
    },
    route: (client, fallback = {}) => {
      client.$queryRaw.mockImplementation(async (strings, ...values) =>
        isSplitSql(strings, values)
          ? rawQuery(strings, ...values)
          : fallback.queryRaw
          ? fallback.queryRaw(strings, ...values)
          : []
      );
      client.$executeRaw.mockImplementation(async (strings, ...values) =>
        isSplitSql(strings, values)
          ? rawExecute(strings, ...values)
          : fallback.executeRaw
          ? fallback.executeRaw(strings, ...values)
          : 0
      );
    },
  };
}
