import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createKyselyClients } from '@civitai/db/kysely';
import { Kysely, type KyselyPlugin, type QueryId } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, describe, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { executableSchemaSql, pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * `changePageRoles` against a real Postgres server, for the one thing PGlite cannot show: a second
 * session. A grant edited by hand (SQL, outside the app) while a save is between its locked read and its
 * write must not be overwritten by that save. History stays on PGlite; only the grant needs two sessions.
 */

const SERVER_URL = process.env.MODERATOR_TEST_DATABASE_URL;
const describePg = SERVER_URL ? describe : describe.skip;
if (process.env.CI && !SERVER_URL) throw new Error('MODERATOR_TEST_DATABASE_URL is not set in CI');

const handles = vi.hoisted(() => ({ main: null as unknown, history: null as unknown }));
vi.mock('../db', () => ({
  get dbRead() {
    return handles.main;
  },
  get dbWrite() {
    return handles.main;
  },
}));
vi.mock('../moderator-db', () => ({ getModeratorDb: () => handles.history }));
vi.mock('../redis', () => ({
  getSysRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));

const { changePageRoles } = await import('../page-access');

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');
const APP_PAGE_ACCESS_DDL = read(
  '../../../../../../packages/civitai-db-schema/prisma/migrations/20260803120000_add_app_page_access/migration.sql'
);
const HISTORY_DDL = executableSchemaSql(read('../../../../page-access/schema.sql'));

const HIGH = 'moderator:mod-high-access';
const CM = 'moderator:cm-high-access';
const SYSTEM = 'system:dispute-agent';

// Fires once, after the save's SECOND read of "AppPageAccess" returns: the first is the unlocked read
// the compare-and-set uses, the second is the read under the grant lock, right before the write.
const race: {
  run: (() => Promise<unknown>) | null;
  reads: number;
  at: QueryId | null;
  landed: Promise<unknown> | null;
} = { run: null, reads: 0, at: null, landed: null };

const afterLockedRead: KyselyPlugin = {
  transformQuery(args) {
    const { node } = args;
    if (
      race.run &&
      node.kind === 'SelectQueryNode' &&
      JSON.stringify(node.from).includes('"AppPageAccess"') &&
      ++race.reads === 2
    )
      race.at = args.queryId;
    return node;
  },
  async transformResult(args) {
    if (race.run && race.at === args.queryId) {
      race.landed = race.run();
      race.run = null;
      // Time for it to land. Held by a row lock it cannot, and the save goes on without it.
      await Promise.race([race.landed, new Promise((r) => setTimeout(r, 500))]);
    }
    return args.result;
  },
};

const connect = (connectionString: string, plugins: KyselyPlugin[] = []) =>
  createKyselyClients<Record<string, never>>({ connectionString, singleClient: true, plugins });

describePg('changePageRoles against a hand edit in another session', () => {
  const name = `mod_page_access_${randomBytes(4).toString('hex')}`;
  let server: ReturnType<typeof connect>;
  let save: ReturnType<typeof connect>;
  let hand: ReturnType<typeof connect>;
  let history: PGlite;

  beforeAll(async () => {
    server = connect(SERVER_URL!);
    await server.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(SERVER_URL!);
    url.pathname = `/${name}`;
    save = connect(url.toString(), [afterLockedRead]);
    hand = connect(url.toString());
    await hand.pool.query(APP_PAGE_ACCESS_DDL);
    handles.main = save.db;
  });

  afterAll(async () => {
    await save?.pool.end();
    await hand?.pool.end();
    await server?.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await server?.pool.end();
  });

  beforeEach(async () => {
    history = await freshPglite();
    await history.exec(HISTORY_DDL);
    handles.history = new Kysely({ dialect: pgliteDialect(history) });
    await hand.pool.query(`DELETE FROM "AppPageAccess"`);
    await hand.pool.query(
      `INSERT INTO "AppPageAccess" (app, path, roles) VALUES ('moderator', '/blocklists', $1)`,
      [[HIGH, SYSTEM]]
    );
    Object.assign(race, { run: null, reads: 0, at: null, landed: null });
  });

  afterEach(async () => {
    await history.close();
  });

  const stored = async () =>
    (
      await hand.pool.query<{ roles: string[] }>(
        `SELECT roles FROM "AppPageAccess" WHERE app = 'moderator' AND path = '/blocklists'`
      )
    ).rows[0]?.roles;

  it('does not overwrite a hand edit that lands after the locked read', async () => {
    // The service role is taken off by hand while a save that keeps it is mid-write.
    race.run = () =>
      hand.pool.query(
        `UPDATE "AppPageAccess" SET roles = $1 WHERE app = 'moderator' AND path = '/blocklists'`,
        [[HIGH]]
      );
    await changePageRoles({
      entries: [{ path: '/blocklists', roles: [HIGH, SYSTEM, CM] }],
      userId: 9,
      via: 'api',
      gateRef: 'g',
      expect: { '/blocklists': [HIGH, SYSTEM] },
    });
    expect(race.landed).not.toBeNull(); // the hook fired: otherwise this test proves nothing
    await race.landed;
    expect(await stored()).toEqual([HIGH]);
  });
});
