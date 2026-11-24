import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { BlockRegistry } from '~/server/services/block-registry.service';
import {
  noteRunnerQuarantine,
  orderRemixApps,
  REMIX_AUTHOR_HELD,
  remixAppBlockRowId,
  saveRemixApp,
} from '~/server/services/remix-app-registry.service';
import { RemixQuarantinedError } from '~/server/services/remix-app-runner';
import { REMIX_STATUSES } from '~/shared/remix-apps/row.schema';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';

/**
 * The seed migration against Postgres, and the App Blocks reads that serve apps to people: the
 * store listing, the featured rail and the page-app resolve every token mint goes through. Remix
 * rows live in `app_blocks` but must never reach any of them.
 */

const migrationSql = (name: string) =>
  readFileSync(
    path.join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql'),
    'utf8'
  );
const MIGRATION = '20261225120200_remix_apps_as_rows';
/** Run before the seed in every writable env; prod's status CHECK rejects 'remix' without them. */
const SCHEMA_MIGRATIONS = [
  '20261225120130_app_blocks_status_allow_remix',
  '20261225120140_validate_app_blocks_status_allow_remix',
];

/**
 * The app_blocks CHECKs as prod has them, read from the migration that created them, so a row the
 * seed or a mod write makes is held to the same rules. Throws if one is no longer found there.
 */
const PROD_CHECKS = [
  'app_blocks_status_check',
  'app_blocks_content_rating_check',
  'app_blocks_id_length_check',
];
const prodChecks = () => {
  const sql = migrationSql('20260524120000_app_blocks_initial');
  return PROD_CHECKS.map((name) => {
    const check = sql.match(new RegExp(`CONSTRAINT "${name}"\\s+CHECK (\\(.+\\))[,;]?$`, 'm'))?.[1];
    if (!check) throw new Error(`${name} not found in 20260524120000_app_blocks_initial`);
    return `ALTER TABLE app_blocks ADD CONSTRAINT "${name}" CHECK ${check};`;
  }).join('\n');
};

// The columns the migration and the reads under test touch, with the schema's defaults.
const DDL = `
  CREATE TABLE "User" (id int PRIMARY KEY);
  CREATE TABLE "OauthClient" (
    id text PRIMARY KEY, secret text, name text NOT NULL, description text NOT NULL DEFAULT '',
    "logoUrl" text, "redirectUris" text[] NOT NULL DEFAULT '{}', "allowedOrigins" text[] NOT NULL DEFAULT '{}',
    grants text[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
    "allowedScopes" int NOT NULL DEFAULT 33554431, "isConfidential" boolean NOT NULL DEFAULT true,
    "accessMode" text NOT NULL DEFAULT 'open', "userId" int NOT NULL REFERENCES "User"(id),
    "isVerified" boolean NOT NULL DEFAULT false,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE app_blocks (
    id text PRIMARY KEY, app_id text NOT NULL REFERENCES "OauthClient"(id), block_id text NOT NULL UNIQUE,
    version text NOT NULL, manifest jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
    content_rating text NOT NULL, category text, featured boolean NOT NULL DEFAULT false,
    featured_order int, external_url text, approved_scopes text[] NOT NULL DEFAULT '{}',
    screenshots jsonb, current_version_deployed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE block_user_subscriptions (app_block_id text, user_id int);
`;

let db: PGlite;
const migrate = () => db.exec(migrationSql(MIGRATION));
const rows = async () =>
  (
    await db.query<{ id: string; status: string; featured_order: number }>(
      'SELECT id, status, featured_order FROM app_blocks ORDER BY featured_order'
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(DDL);
  await db.exec(prodChecks());
  for (const name of SCHEMA_MIGRATIONS) await db.exec(migrationSql(name));
  await db.exec(`INSERT INTO "User" (id) VALUES (-1)`);
});
afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  const raw = pgliteRaw(db);
  dbMock.dbRead.$queryRaw.mockImplementation(raw.queryRaw as never);
});

describe('remix apps seed migration', () => {
  it('inserts the client and one listed row per seed app, in menu order', async () => {
    await migrate();
    expect(await rows()).toEqual(
      SEED_REMIX_APPS.map((app, order) => ({
        id: remixAppBlockRowId(app.slug),
        status: 'remix',
        featured_order: order,
      }))
    );
    const client = (await db.query(`SELECT * FROM "OauthClient"`)).rows[0];
    expect(client).toMatchObject({
      id: 'civitai-remix-apps',
      secret: null,
      redirectUris: [],
      grants: [],
      allowedScopes: 0,
      accessMode: 'disabled',
      userId: -1,
    });
  });

  it('re-applies as a no-op that keeps a mod edit', async () => {
    await db.exec(
      `UPDATE app_blocks SET status = 'remix_disabled', manifest = manifest || '{"name":"Edited"}' WHERE block_id = 'remix-anime-it'`
    );
    await migrate();
    const [anime] = (
      await db.query<{ status: string; name: string }>(
        `SELECT status, manifest->>'name' AS name FROM app_blocks WHERE block_id = 'remix-anime-it'`
      )
    ).rows;
    expect(anime).toEqual({ status: 'remix_disabled', name: 'Edited' });
    expect(await rows()).toHaveLength(SEED_REMIX_APPS.length);
  });

  it('holds the prod CHECKs: a bad status or a short id is rejected', async () => {
    // POSITIVE CONTROL: the CHECKs are applied, so the passes above are not a table without them.
    await expect(
      db.exec(`UPDATE app_blocks SET status = 'bogus' WHERE block_id = 'remix-anime-it'`)
    ).rejects.toThrow(/app_blocks_status_check/);
    await expect(
      db.exec(`UPDATE app_blocks SET id = 'ab_short' WHERE block_id = 'remix-anime-it'`)
    ).rejects.toThrow(/app_blocks_id_length_check/);
  });
});

describe('saveRemixApp against the prod CHECKs', () => {
  it('creates a new app as a disabled row', async () => {
    // The slug at its longest makes the longest id.
    const slug = 'a'.repeat(34);
    dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({ id: 'civitai-remix-apps' } as never);
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.appBlock.aggregate.mockResolvedValue({ _max: { featuredOrder: 7 } } as never);
    dbMock.dbWrite.appBlock.create.mockImplementation((async ({
      data,
    }: {
      data: Record<string, unknown>;
    }) =>
      db.query(
        `INSERT INTO app_blocks (id, app_id, block_id, version, manifest, status, content_rating, featured_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          data.id,
          data.appId,
          data.blockId,
          data.version,
          JSON.stringify(data.manifest),
          data.status,
          data.contentRating,
          data.featuredOrder,
        ]
      )) as never);
    redisMock.redis.set.mockResolvedValue('OK' as never);

    await saveRemixApp({ ...SEED_REMIX_APPS[0], slug });
    const [row] = (
      await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM app_blocks WHERE block_id = $1`,
        [`remix-${slug}`]
      )
    ).rows;
    expect(row).toEqual({ id: remixAppBlockRowId(slug), status: 'remix_disabled' });
    expect(row.id).toHaveLength(40);
    await db.exec(`DELETE FROM app_blocks WHERE block_id = 'remix-${slug}'`);
  });
});

describe("an author's runner trip, in one transaction against Postgres", () => {
  it('locks the real table, then writes the trip and the hold', async () => {
    const raw = pgliteRaw(db);
    const blockId = 'remix-u5-probe';
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO "OauthClient" (id, name, "userId") VALUES ('civitai-remix-apps', 'Remix', -1)
       ON CONFLICT DO NOTHING`
    );
    await db.query(
      `INSERT INTO app_blocks (id, app_id, block_id, version, manifest, status, content_rating)
       VALUES ($1, 'civitai-remix-apps', $2, '1.0.0', $3, 'remix', 'pg')`,
      [
        remixAppBlockRowId('u5-probe'),
        blockId,
        JSON.stringify({ kind: 'remix', author: { userId: 5 }, runnerTrips: [recent, recent] }),
      ]
    );
    // Another author's app: never locked by this author's trip.
    await db.query(
      `INSERT INTO app_blocks (id, app_id, block_id, version, manifest, status, content_rating)
       VALUES ($1, 'civitai-remix-apps', 'remix-u6-other', '1.0.0', '{}', 'remix', 'pg')`,
      [remixAppBlockRowId('u6-other')]
    );
    // The transaction's client: its raw lock and its reads and writes all reach Postgres.
    let lockedByThisTransaction: unknown;
    const tx = {
      $executeRaw: raw.executeRaw,
      $queryRaw: async (...args: Parameters<typeof raw.queryRaw>) => {
        const locked = await raw.queryRaw(...args);
        // A row this transaction locked carries its id in xmax: proof the statement takes row locks,
        // on the author's rows only. (Serialisation across connections needs a second one.)
        lockedByThisTransaction = (
          await db.query<{ block_id: string; mine: boolean }>(
            `SELECT block_id, xmax::text = (txid_current() % 4294967296)::text AS mine
             FROM app_blocks WHERE block_id LIKE 'remix-u%' ORDER BY block_id`
          )
        ).rows;
        return locked;
      },
      appBlock: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          (
            await db.query<{ id: string; blockId: string; manifest: unknown }>(
              `SELECT id, block_id AS "blockId", manifest FROM app_blocks WHERE id = ANY($1)`,
              [where.id.in]
            )
          ).rows,
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { manifest: unknown };
        }) => {
          await db.query(`UPDATE app_blocks SET manifest = $1 WHERE id = $2`, [
            JSON.stringify(data.manifest),
            where.id,
          ]);
          return { count: 1 };
        },
      },
    };
    dbMock.dbWrite.$transaction.mockImplementation((async (fn: (t: typeof tx) => unknown) => {
      await db.exec('BEGIN');
      try {
        const out = await fn(tx);
        await db.exec('COMMIT');
        return out;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }) as never);
    redisMock.redis.set.mockResolvedValue('OK' as never);

    const refusal = await noteRunnerQuarantine(
      { slug: 'u5-probe', author: { userId: 5 } },
      5,
      new RemixQuarantinedError('a'.repeat(64), true)
    );
    expect(refusal).toEqual({ kind: 'held', message: REMIX_AUTHOR_HELD });
    const [row] = (
      await db.query<{ manifest: { runnerTrips: string[]; runnerHold?: unknown } }>(
        `SELECT manifest FROM app_blocks WHERE block_id = $1`,
        [blockId]
      )
    ).rows;
    // Held because it was written, not because a failed write fails closed.
    expect(row.manifest.runnerTrips).toHaveLength(3);
    expect(row.manifest.runnerHold).toBeTruthy();
    expect(lockedByThisTransaction).toEqual([
      { block_id: 'remix-u5-probe', mine: true },
      { block_id: 'remix-u6-other', mine: false },
    ]);
    await db.exec(`DELETE FROM app_blocks WHERE block_id IN ('${blockId}', 'remix-u6-other')`);
  });
});

describe('reordering the menu, in one transaction against Postgres', () => {
  it("locks every row it moves first, through the runner trip's statement, then writes the order", async () => {
    const raw = pgliteRaw(db);
    // Ids a locale sort and a code-unit sort put in opposite orders: a JS sort of the ids would
    // not match the lock order a runner trip takes.
    const slugs = ['u5-a-b', 'u5-a1'];
    const [x, y] = slugs.map(remixAppBlockRowId);
    expect(x.localeCompare(y)).not.toBe(Math.sign(x < y ? -1 : 1));
    for (const slug of slugs)
      await db.query(
        `INSERT INTO app_blocks (id, app_id, block_id, version, manifest, status, content_rating)
         VALUES ($1, 'civitai-remix-apps', $2, '1.0.0', '{}', 'remix', 'pg')`,
        [remixAppBlockRowId(slug), `remix-${slug}`]
      );
    const events: string[] = [];
    const tx = {
      $executeRaw: raw.executeRaw,
      $queryRaw: async (...args: Parameters<typeof raw.queryRaw>) => {
        const locked = (await raw.queryRaw(...args)) as { id: string }[];
        const mine = (
          await db.query<{ block_id: string; mine: boolean }>(
            `SELECT block_id, xmax::text = (txid_current() % 4294967296)::text AS mine
             FROM app_blocks WHERE block_id LIKE 'remix-u5-a%' ORDER BY block_id`
          )
        ).rows;
        events.push(`lock ${locked.map(({ id }) => id).join(',')}`);
        events.push(`mine ${mine.map((r) => `${r.block_id}=${r.mine}`).join(',')}`);
        return locked;
      },
      appBlock: {
        updateMany: async ({
          where,
          data,
        }: {
          where: { blockId: string; status: { in: string[] } };
          data: { featuredOrder: number };
        }) => {
          events.push(`write ${where.blockId}`);
          const { affectedRows } = await db.query(
            `UPDATE app_blocks SET featured_order = $1 WHERE block_id = $2 AND status = ANY($3)`,
            [data.featuredOrder, where.blockId, where.status.in]
          );
          return { count: affectedRows ?? 0 };
        },
      },
    };
    dbMock.dbWrite.$transaction.mockImplementation((async (fn: (t: typeof tx) => unknown) => {
      await db.exec('BEGIN');
      try {
        const out = await fn(tx);
        await db.exec('COMMIT');
        return out;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }) as never);
    redisMock.redis.set.mockResolvedValue('OK' as never);

    await orderRemixApps(['u5-a1', 'u5-a-b']);

    const byId = (
      await db.query<{ id: string }>(
        `SELECT id FROM app_blocks WHERE block_id LIKE 'remix-u5-a%' ORDER BY id`
      )
    ).rows.map(({ id }) => id);
    expect(events).toEqual([
      `lock ${byId.join(',')}`,
      'mine remix-u5-a-b=true,remix-u5-a1=true',
      'write remix-u5-a1',
      'write remix-u5-a-b',
    ]);
    expect(
      (
        await db.query<{ block_id: string; featured_order: number }>(
          `SELECT block_id, featured_order FROM app_blocks WHERE block_id LIKE 'remix-u5-a%' ORDER BY block_id`
        )
      ).rows
    ).toEqual([
      { block_id: 'remix-u5-a-b', featured_order: 1 },
      { block_id: 'remix-u5-a1', featured_order: 0 },
    ]);
    await db.exec(`DELETE FROM app_blocks WHERE block_id LIKE 'remix-u5-a%'`);
  });
});

describe('App Blocks reads that serve apps', () => {
  const ids = async (list: { id: string }[]) => list.map((b) => b.id);
  const listed = async () =>
    ids(
      (
        await BlockRegistry.listAvailable(
          { sort: 'name', limit: 50 } as Parameters<typeof BlockRegistry.listAvailable>[0],
          false,
          true
        )
      ).items
    );
  const featured = async () => ids(await BlockRegistry.getFeaturedBlocks(50, false, true));
  /** The one remix row, made to look like a live, featured store app apart from its status. */
  const dressUp = (status: string) =>
    db.exec(
      `UPDATE app_blocks SET status = '${status}', featured = true, current_version_deployed_at = now() WHERE block_id = 'remix-restyle'`
    );

  it('leave every remix row out of the store and the featured rail', async () => {
    await dressUp('remix');
    expect(await listed()).toEqual([]);
    expect(await featured()).toEqual([]);

    // POSITIVE CONTROL: the same row with an approved status is listed and featured, so the
    // empty lists above are the status, not a query that sees nothing.
    await dressUp('approved');
    expect(await listed()).toEqual([remixAppBlockRowId('restyle')]);
    expect(await featured()).toEqual([remixAppBlockRowId('restyle')]);
    await dressUp('remix');
  });

  it('resolve no page app, so mint no token, for a remix row', async () => {
    const [row] = (
      await db.query<Record<string, unknown>>(
        `SELECT id, block_id AS "blockId", app_id AS "appId", status, manifest FROM app_blocks WHERE block_id = 'remix-anime-it'`
      )
    ).rows;
    const serve = (over: Record<string, unknown>) =>
      dbMock.dbWrite.appBlock.findUnique.mockResolvedValue({
        ...row,
        approvedScopes: [],
        currentVersionDeployedAt: new Date(),
        app: { allowedScopes: 0n },
        ...over,
      } as never);

    for (const status of REMIX_STATUSES) {
      serve({ status });
      expect(await BlockRegistry.resolvePageBlock(row.id as string)).toBeNull();
    }
    // POSITIVE CONTROL: approved and declaring a page, the same row resolves.
    serve({
      status: 'approved',
      manifest: { ...(row.manifest as object), page: { path: '/', title: 'Anime it' } },
    });
    expect(await BlockRegistry.resolvePageBlock(row.id as string)).not.toBeNull();
  });
});
