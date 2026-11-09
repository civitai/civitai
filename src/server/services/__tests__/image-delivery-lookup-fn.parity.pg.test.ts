import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageDeliveryStatement } from '~/server/services/image-delivery.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

// How a caller reads the row through the function: the same columns the inline statement selects.
const imageDeliveryFunctionStatement = (url: string) =>
  Prisma.sql`SELECT id, url, "hideMeta", type, "mimeType" FROM image_delivery_lookup(${url})`;

/**
 * Parity gate for `image_delivery_lookup(url)`: the SQL function in migration
 * 20261106120000_image_delivery_lookup_fn must return exactly the row the endpoint's inline
 * statement returns, for every case the rule distinguishes. Both run against the same rows in a
 * REAL Postgres, and each case also pins the expected row literally, so the two cannot agree on a
 * wrong answer.
 *
 * The migration is applied VERBATIM (read from the file), as a non-superuser role that owns
 * "Image" — the ownership the migration asks for — in a database where schema public is closed to
 * PUBLIC, as it is in production. The privilege cases then check what the migration's comment tells
 * a human to grant.
 *
 * Runs in CI: the `unit` job points IMAGE_DELIVERY_LOOKUP_FN_PARITY_DATABASE_URL at its throwaway
 * Postgres, and the last test fails there if that wiring is lost. Locally it skips without the URL,
 * which must point at a THROWAWAY server the URL's user can create databases and roles on: the
 * suite drops and recreates the `image_delivery_lookup_fn_parity` database and three roles.
 */
const adminUrl = process.env.IMAGE_DELIVERY_LOOKUP_FN_PARITY_DATABASE_URL;
const DATABASE = 'image_delivery_lookup_fn_parity';
const ROLE = {
  owner: 'idl_fn_parity_owner', // owns "Image" and the function
  caller: 'idl_fn_parity_caller', // EXECUTE + USAGE on public: what a reader is granted
  stranger: 'idl_fn_parity_stranger', // USAGE on public only
  noUsage: 'idl_fn_parity_no_usage', // EXECUTE only
} as const;

const MIGRATION = resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261106120000_image_delivery_lookup_fn/migration.sql'
);

const databaseUrl = (url: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${DATABASE}`;
  return parsed.toString();
};

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
// Ids are distinct from each other and from every other value in a row.
type Row = {
  id: number;
  url: string;
  hideMeta: boolean;
  type: 'image' | 'video' | 'audio';
  mimeType: string | null;
  ingestion: ImageIngestionStatus;
};

const FOUND = 'parity/found.jpeg';
const HIDDEN_VIDEO = 'parity/hidden.mp4';
const SHOWN_THEN_HIDDEN = 'parity/shown-then-hidden.png'; // the shown row is first in scan order
const HIDDEN_THEN_SHOWN = 'parity/hidden-then-shown.png'; // the hidden row is first in scan order
const GONE_SHOWN = 'parity/gone-shown.webp';
const GONE_HIDDEN = 'parity/gone-hidden.webp';
const GONE_THEN_LIVE = 'parity/gone-then-live.webp';
const NULL_MIME = 'parity/legacy.jpeg';
const UPPER_HEX = 'ABCDEF12-3456-4789-ABCD-EF0123456789';
const LOWER_HEX = UPPER_HEX.toLowerCase();
const MIXED_HEX = 'Abcdef12-3456-4789-abcd-ef0123456789';
const MISSING = 'parity/missing.jpeg';

// Inserted in this order; with no index on url, that is the scan order a missing ORDER BY returns.
const ROWS: Row[] = [
  {
    id: 9301,
    url: FOUND,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/jpeg',
    ingestion: 'Scanned',
  },
  {
    id: 9302,
    url: HIDDEN_VIDEO,
    hideMeta: true,
    type: 'video',
    mimeType: 'video/mp4',
    ingestion: 'Scanned',
  },
  {
    id: 9303,
    url: SHOWN_THEN_HIDDEN,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/png',
    ingestion: 'Scanned',
  },
  {
    id: 9304,
    url: SHOWN_THEN_HIDDEN,
    hideMeta: true,
    type: 'image',
    mimeType: 'image/png',
    ingestion: 'Pending',
  },
  {
    id: 9305,
    url: HIDDEN_THEN_SHOWN,
    hideMeta: true,
    type: 'image',
    mimeType: 'image/png',
    ingestion: 'Scanned',
  },
  {
    id: 9306,
    url: HIDDEN_THEN_SHOWN,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/png',
    ingestion: 'Scanned',
  },
  {
    id: 9307,
    url: GONE_SHOWN,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/webp',
    ingestion: 'NotFound',
  },
  {
    id: 9308,
    url: GONE_HIDDEN,
    hideMeta: true,
    type: 'image',
    mimeType: 'image/webp',
    ingestion: 'NotFound',
  },
  {
    id: 9309,
    url: GONE_THEN_LIVE,
    hideMeta: false,
    type: 'image',
    mimeType: 'image/webp',
    ingestion: 'NotFound',
  },
  {
    id: 9310,
    url: GONE_THEN_LIVE,
    hideMeta: false,
    type: 'audio',
    mimeType: 'audio/mpeg',
    ingestion: 'Error',
  },
  {
    id: 9311,
    url: NULL_MIME,
    hideMeta: false,
    type: 'image',
    mimeType: null,
    ingestion: 'Blocked',
  },
  {
    id: 9312,
    url: UPPER_HEX,
    hideMeta: true,
    type: 'image',
    mimeType: 'image/jpeg',
    ingestion: 'Scanned',
  },
  {
    id: 9313,
    url: LOWER_HEX,
    hideMeta: false,
    type: 'video',
    mimeType: 'video/webm',
    ingestion: 'Scanned',
  },
];

const rowById = (id: number) => {
  const { ingestion: _, ...row } = ROWS.find((r) => r.id === id)!;
  return row;
};

const MEDIA_TYPES = ['image', 'video', 'audio'];

describe.skipIf(!adminUrl)(
  'image_delivery_lookup(url) returns what the inline statement returns',
  () => {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    let pool: Pool;
    let tearingDown = false;
    const ADMIN_SHUTDOWN = '57P01'; // terminating connection due to administrator command

    const run = async (statement: Prisma.Sql, client?: PoolClient) =>
      (await (client ?? pool).query(statement.text, statement.values as unknown[])).rows;

    // Each statement as `role`, on one connection so the SET ROLE holds; reset before release.
    const asRole = async <T>(role: string, work: (client: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE "${role}"`);
        return await work(client);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    };

    const dropAll = async () => {
      await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
      for (const role of Object.values(ROLE)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    };

    beforeAll(async () => {
      await dropAll();
      await admin.query(`CREATE DATABASE "${DATABASE}"`);
      for (const role of Object.values(ROLE)) await admin.query(`CREATE ROLE "${role}" NOLOGIN`);

      pool = new Pool({ connectionString: databaseUrl(adminUrl as string), max: 2 });
      // pool.end() resolves once its clients are SENT their terminate, not once their sockets close,
      // so the FORCE drop in afterAll can kill a backend whose client is still closing. That client
      // receives a FATAL 57P01, and pg-pool re-emits it on the pool; with no listener, Vitest reports
      // an unhandled error and fails the run. Ignore exactly that error during teardown; any other
      // pool error is rethrown.
      pool.on('error', (err) => {
        if (tearingDown && (err as Error & { code?: string }).code === ADMIN_SHUTDOWN) return;
        throw err;
      });
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
      const setup = await pool.connect();
      try {
        await setup.query(`
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT USAGE, CREATE ON SCHEMA public TO "${ROLE.owner}";
        GRANT USAGE ON SCHEMA public TO "${ROLE.caller}", "${ROLE.stranger}";
        CREATE TYPE "MediaType" AS ENUM (${MEDIA_TYPES.map(q).join(', ')});
        CREATE TYPE "ImageIngestionStatus" AS ENUM (${Object.values(ImageIngestionStatus)
          .map(q)
          .join(', ')});
        CREATE TABLE "Image" (
          "id" INTEGER NOT NULL PRIMARY KEY,
          "url" TEXT NOT NULL,
          "hideMeta" BOOLEAN NOT NULL DEFAULT false,
          "type" "MediaType" NOT NULL DEFAULT 'image',
          "mimeType" TEXT,
          "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Pending'
        );
        ALTER TABLE "Image" OWNER TO "${ROLE.owner}";
      `);
        for (const row of ROWS)
          await setup.query(
            `INSERT INTO "Image" (id, url, "hideMeta", type, "mimeType", ingestion) VALUES ($1, $2, $3, $4, $5, $6)`,
            [row.id, row.url, row.hideMeta, row.type, row.mimeType, row.ingestion]
          );

        await setup.query(`SET ROLE "${ROLE.owner}"`);
        await setup.query(readFileSync(MIGRATION, 'utf8'));
        await setup.query('RESET ROLE');
        await setup.query(`
        GRANT EXECUTE ON FUNCTION public.image_delivery_lookup(text) TO "${ROLE.caller}", "${ROLE.noUsage}";
      `);
      } finally {
        setup.release();
      }
    });

    afterAll(async () => {
      tearingDown = true;
      await pool?.end();
      await dropAll();
      await admin.end();
    });

    describe('same row as the inline statement', () => {
      it.each<[string, string, number | null]>([
        ['found', FOUND, 9301],
        ['a hidden video', HIDDEN_VIDEO, 9302],
        [
          'two rows share the url, shown first in scan order: the hidden one wins',
          SHOWN_THEN_HIDDEN,
          9304,
        ],
        [
          'two rows share the url, hidden first in scan order: the hidden one wins',
          HIDDEN_THEN_SHOWN,
          9305,
        ],
        ['source gone, metadata shown: left out', GONE_SHOWN, null],
        ['source gone, metadata hidden: kept', GONE_HIDDEN, 9308],
        ['a gone row and a live row share the url: the live one', GONE_THEN_LIVE, 9310],
        ['a NULL mimeType comes back NULL', NULL_MIME, 9311],
        ['an uppercase-hex url matches only itself', UPPER_HEX, 9312],
        ['its lowercase twin matches only itself', LOWER_HEX, 9313],
        ['a mixed-case spelling of both matches neither', MIXED_HEX, null],
        ['no row for the url', MISSING, null],
        ['an empty url', '', null],
      ])('%s', async (_, url, id) => {
        const expected = id === null ? [] : [rowById(id)];
        const inline = await run(imageDeliveryStatement(url));
        const viaFunction = await run(imageDeliveryFunctionStatement(url));

        expect(inline).toStrictEqual(expected);
        expect(viaFunction).toStrictEqual(expected);
      });
    });

    describe('privileges', () => {
      it('a role granted EXECUTE (and USAGE on public) reads the row and still cannot read "Image"', async () => {
        await asRole(ROLE.caller, async (client) => {
          expect(await run(imageDeliveryFunctionStatement(FOUND), client)).toStrictEqual([
            rowById(9301),
          ]);
          await expect(client.query('SELECT id FROM public."Image" LIMIT 1')).rejects.toThrow(
            /permission denied for table Image/
          );
        });
      });

      it('a role without EXECUTE is refused: EXECUTE is revoked from PUBLIC', async () => {
        await asRole(ROLE.stranger, async (client) => {
          await expect(run(imageDeliveryFunctionStatement(FOUND), client)).rejects.toThrow(
            /permission denied for function image_delivery_lookup/
          );
        });
      });

      // Without USAGE an unqualified call cannot even find the function, and a schema-qualified
      // one (the form another service sends) is refused at the schema.
      it('a role with EXECUTE but no USAGE on public cannot call it', async () => {
        await asRole(ROLE.noUsage, async (client) => {
          await expect(run(imageDeliveryFunctionStatement(FOUND), client)).rejects.toThrow(
            /function image_delivery_lookup\(unknown\) does not exist/
          );
          await expect(
            client.query('SELECT "hideMeta" FROM public.image_delivery_lookup($1)', [FOUND])
          ).rejects.toThrow(/permission denied for schema public/);
        });
      });

      // beforeAll applied the file as the owner of "Image", which succeeded. Applied as a superuser
      // (CI's own user, checked first so the refusal cannot come from a missing privilege instead),
      // it must refuse before creating anything: the function is dropped inside a transaction, the
      // file run, and the function is still absent afterwards. All of it is rolled back.
      it('refuses to run as a superuser, and creates nothing', async () => {
        const client = await pool.connect();
        try {
          const [me] = (
            await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
          ).rows;
          expect(me).toStrictEqual({ rolsuper: true });

          await client.query('BEGIN');
          await client.query('DROP FUNCTION public.image_delivery_lookup(text)');
          await client.query('SAVEPOINT before_apply');
          await expect(client.query(readFileSync(MIGRATION, 'utf8'))).rejects.toThrow(
            'apply as the owner of "Image" (SET ROLE <owner>), not a superuser'
          );
          await client.query('ROLLBACK TO SAVEPOINT before_apply');
          const [fn] = (
            await client.query(
              `SELECT to_regprocedure('public.image_delivery_lookup(text)') IS NULL AS absent`
            )
          ).rows;
          expect(fn).toStrictEqual({ absent: true });
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });

      it('is SECURITY DEFINER, STABLE, owned by the table owner, with a pinned search_path', async () => {
        const [fn] = (
          await pool.query(`
          SELECT p.prosecdef, p.provolatile, p.proisstrict, p.proconfig, r.rolname AS owner
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.oid = 'public.image_delivery_lookup(text)'::regprocedure
        `)
        ).rows;
        expect(fn).toStrictEqual({
          prosecdef: true,
          provolatile: 's',
          proisstrict: true,
          proconfig: ['search_path=pg_catalog, pg_temp'],
          owner: ROLE.owner,
        });
      });
    });
  }
);

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the database is wired', () => {
  expect(adminUrl).toBeTruthy();
});
