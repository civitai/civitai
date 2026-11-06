import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { REMIX_STATUSES } from '~/shared/remix-apps/row.schema';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';

/**
 * The seed migration against Postgres, and the App Blocks reads that serve apps to people: the
 * store listing, the featured rail and the page-app resolve every token mint goes through. Remix
 * rows live in `app_blocks` but must never reach any of them.
 */

const MIGRATION = path.join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261225120000_remix_apps_as_rows/migration.sql'
);

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
const migrate = () => db.exec(readFileSync(MIGRATION, 'utf8'));
const rows = async () =>
  (
    await db.query<{ id: string; status: string; featured_order: number }>(
      'SELECT id, status, featured_order FROM app_blocks ORDER BY featured_order'
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(DDL);
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
        id: expect.stringContaining('apb_remix_'),
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
    expect(await listed()).toEqual(['apb_remix_restyle']);
    expect(await featured()).toEqual(['apb_remix_restyle']);
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
        app: { allowedScopes: 0 },
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
