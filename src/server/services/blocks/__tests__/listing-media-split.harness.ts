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
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261018192800_app_listing_red_media/migration.sql'
);

/** The second migration: the civitai.red icon / cover override columns. */
const RED_SLOTS_MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261019120000_app_listing_red_media_slots/migration.sql'
);

/** One `Image` row with the columns the store gate reads. */
export type SplitDbImage = {
  id: number;
  nsfwLevel: number;
  url?: string;
  ingestion?: string;
  needsReview?: string | null;
  poi?: boolean;
  minor?: boolean;
  tosViolation?: boolean;
  acceptableMinor?: boolean;
  blockedFor?: string | null;
};

export type SplitDb = {
  db: PGlite;
  applyMigration: () => Promise<void>;
  /** Apply the override-columns migration (after {@link SplitDb.applyMigration}). */
  applyRedSlotsMigration: () => Promise<void>;
  /** Insert or replace `Image` rows with every gate column (defaults: scanned, unflagged). */
  seedImages: (images: SplitDbImage[]) => Promise<void>;
  /** Set a listing's override slots directly, as the owning role. */
  setRedSlots: (
    appListingId: string,
    slots: { icon?: number | null; cover?: number | null }
  ) => Promise<void>;
  /** A listing's override slots as stored (read as the owning role); `null` = no row. */
  redSlots: (appListingId: string) => Promise<{ icon: number | null; cover: number | null } | null>;
  seed: (args: {
    listingIds?: string[];
    images?: Record<number, number>;
    users?: number[];
  }) => Promise<void>;
  /** A `$queryRaw`/`$executeRaw` pair backed by this database. */
  raw: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
  stamp: (appListingId: string) => Promise<{ at: string | null; by: number | null } | null>;
  /**
   * Switch this connection to a role that may do everything to the other tables but only
   * `privileges` on `app_listing_red_media` (none: present but unreadable) — the state of an
   * environment where the table was created without granting it to the role the app connects
   * as. Call after {@link SplitDb.applyMigration}. {@link SplitDb.stamp} reads as the owner.
   */
  restrictTo: (privileges: ('SELECT' | 'INSERT' | 'UPDATE')[]) => Promise<void>;
  /** Back to the owning role (a no-op when not restricted). */
  unrestrict: () => Promise<void>;
  /**
   * A raw-SQL client that runs each statement AS its own role holding only `privileges` on
   * `app_listing_red_media` — so two clients (the app's read and write pools) can hold different
   * grants on one database. Use on an unrestricted connection; statements run one at a time.
   */
  clientAs: (
    privileges: ('SELECT' | 'INSERT' | 'UPDATE')[]
  ) => Promise<Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>>;
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
  // A caller may pass a prebuilt `Prisma.sql` object rather than a template; those are never
  // the split service's (it only uses tagged templates), so they keep answering the fallback.
  if (!Array.isArray(strings)) return false;
  const text = Prisma.sql(strings, ...values).text;
  return text.includes('app_listing_red_media') || /FROM "Image" WHERE id IN/.test(text);
};

export async function createSplitDb(): Promise<SplitDb> {
  const db = new PGlite();
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" (id INT PRIMARY KEY);
    CREATE TABLE "Image" (
      id INT PRIMARY KEY,
      "nsfwLevel" INT NOT NULL DEFAULT 0,
      url TEXT NOT NULL DEFAULT '',
      ingestion TEXT NOT NULL DEFAULT 'Scanned',
      "needsReview" TEXT,
      poi BOOLEAN NOT NULL DEFAULT false,
      minor BOOLEAN NOT NULL DEFAULT false,
      "tosViolation" BOOLEAN NOT NULL DEFAULT false,
      "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
      "blockedFor" TEXT
    );
    CREATE TABLE "app_listings" (id TEXT PRIMARY KEY, content_rating TEXT);
  `);
  const pg = pgliteRaw(db);
  const raw = {
    $queryRaw: pg.queryRaw,
    $executeRaw: pg.executeRaw,
  } as unknown as Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
  const rawQuery = pg.queryRaw as RawFn;
  const rawExecute = pg.executeRaw as RawFn;
  const readStamp = async (appListingId: string) => {
    const { rows } = await db.query<{ at: string | null; by: number | null }>(
      `SELECT media_split_approved_at::text AS at, media_split_approved_by AS by
       FROM app_listing_red_media WHERE app_listing_id = $1`,
      [appListingId]
    );
    return rows[0] ?? null;
  };
  let restricted = false;
  const asOwner = async <T>(f: () => Promise<T>) => {
    const wasRestricted = restricted;
    if (wasRestricted) await db.exec(`RESET ROLE`);
    try {
      return await f();
    } finally {
      if (wasRestricted) await db.exec(`SET ROLE split_test_client`);
    }
  };
  const unrestrict = async () => {
    if (!restricted) return;
    await db.exec(`RESET ROLE`);
    restricted = false;
  };
  return {
    restrictTo: async (privileges) => {
      await unrestrict();
      await db.exec(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'split_test_client') THEN
            CREATE ROLE split_test_client;
          END IF;
        END $$;
        GRANT ALL ON "User", "Image", app_listings TO split_test_client;
        REVOKE ALL ON app_listing_red_media FROM split_test_client;
      `);
      if (privileges.length)
        await db.exec(
          `GRANT ${privileges.join(', ')} ON app_listing_red_media TO split_test_client`
        );
      await db.exec(`SET ROLE split_test_client`);
      restricted = true;
    },
    unrestrict,
    clientAs: async (privileges) => {
      const role = `split_test_${privileges.length ? privileges.join('_').toLowerCase() : 'none'}`;
      await db.exec(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role};
          END IF;
        END $$;
        GRANT ALL ON "User", "Image", app_listings TO ${role};
        REVOKE ALL ON app_listing_red_media FROM ${role};
      `);
      if (privileges.length)
        await db.exec(`GRANT ${privileges.join(', ')} ON app_listing_red_media TO ${role}`);
      const as =
        <T>(f: RawFn) =>
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          await db.exec(`SET ROLE ${role}`);
          try {
            return (await f(strings, ...values)) as T;
          } finally {
            await db.exec(`RESET ROLE`);
          }
        };
      return {
        $queryRaw: as(rawQuery),
        $executeRaw: as(rawExecute),
      } as unknown as Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
    },
    db,
    raw,
    applyMigration: async () => {
      await db.exec(readFileSync(MIGRATION, 'utf8'));
    },
    applyRedSlotsMigration: async () => {
      await db.exec(readFileSync(RED_SLOTS_MIGRATION, 'utf8'));
    },
    seedImages: async (images) => {
      for (const i of images)
        await db.query(
          `INSERT INTO "Image" (id, "nsfwLevel", url, ingestion, "needsReview", poi, minor,
             "tosViolation", "acceptableMinor", "blockedFor")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO UPDATE SET "nsfwLevel" = EXCLUDED."nsfwLevel", url = EXCLUDED.url,
             ingestion = EXCLUDED.ingestion, "needsReview" = EXCLUDED."needsReview",
             poi = EXCLUDED.poi, minor = EXCLUDED.minor, "tosViolation" = EXCLUDED."tosViolation",
             "acceptableMinor" = EXCLUDED."acceptableMinor", "blockedFor" = EXCLUDED."blockedFor"`,
          [
            i.id,
            i.nsfwLevel,
            i.url ?? `img-${i.id}.png`,
            i.ingestion ?? 'Scanned',
            i.needsReview ?? null,
            i.poi ?? false,
            i.minor ?? false,
            i.tosViolation ?? false,
            i.acceptableMinor ?? false,
            i.blockedFor ?? null,
          ]
        );
    },
    setRedSlots: (appListingId, slots) =>
      asOwner(async () => {
        await db.query(
          `INSERT INTO app_listing_red_media (app_listing_id, red_icon_id, red_cover_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (app_listing_id) DO UPDATE
             SET red_icon_id = EXCLUDED.red_icon_id, red_cover_id = EXCLUDED.red_cover_id`,
          [appListingId, slots.icon ?? null, slots.cover ?? null]
        );
      }),
    redSlots: (appListingId) =>
      asOwner(async () => {
        const { rows } = await db.query<{ icon: number | null; cover: number | null }>(
          `SELECT red_icon_id AS icon, red_cover_id AS cover
           FROM app_listing_red_media WHERE app_listing_id = $1`,
          [appListingId]
        );
        return rows[0] ?? null;
      }),
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
    stamp: (appListingId) => asOwner(() => readStamp(appListingId)),
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
