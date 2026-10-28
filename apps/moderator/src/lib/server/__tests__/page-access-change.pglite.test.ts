import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely, type KyselyPlugin } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executableSchemaSql, pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * `changePageRoles` against real tables: the main database's "AppPageAccess" (from its migration) and
 * the moderator database's `page_access_change` (from `apps/moderator/page-access/schema.sql`). Two
 * PGlite instances, because the two live in different databases and the order between them is the
 * point: a grant that cannot be recorded must not be written.
 */

const handles = vi.hoisted(() => ({
  main: null as unknown,
  history: null as unknown,
  published: [] as string[],
}));
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
  getSysRedis: () => ({
    get: async () => null,
    set: async (_key: string, value: string) => {
      handles.published.push(value);
      return 'OK';
    },
  }),
}));

const { changePageRoles, GrantConflictError, GrantHistoryUnavailableError } = await import(
  '../page-access'
);
const { actions } = await import('../../../routes/admin/+page.server');

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');
const APP_PAGE_ACCESS_DDL = read(
  '../../../../../../packages/civitai-db-schema/prisma/migrations/20260803120000_add_app_page_access/migration.sql'
);
const HISTORY_DDL = executableSchemaSql(read('../../../../page-access/schema.sql'));

const HIGH = 'moderator:mod-high-access';
const CM = 'moderator:cm-high-access';

// Runs once, after the next statement on the history database returns: a write that lands on the
// grant between the history insert and the grant write, which is the window the row lock closes.
const race = { next: null as null | (() => Promise<unknown>) };
const raceAfterHistoryWrite: KyselyPlugin = {
  transformQuery: (args) => args.node,
  async transformResult(args) {
    const run = race.next;
    race.next = null;
    if (run) await run();
    return args.result;
  },
};

let main: PGlite;
let history: PGlite;

beforeEach(async () => {
  main = await freshPglite();
  history = await freshPglite();
  await main.exec(APP_PAGE_ACCESS_DDL);
  await main.exec(`CREATE TABLE "Role" (id text PRIMARY KEY);
    INSERT INTO "Role" VALUES ('moderator:admin'), ('${HIGH}'), ('${CM}');
    INSERT INTO "AppPageAccess" (app, path, roles) VALUES ('moderator', '/blocklists', ARRAY['${HIGH}']);`);
  await history.exec(HISTORY_DDL);
  handles.main = new Kysely({ dialect: pgliteDialect(main) });
  handles.history = new Kysely({
    dialect: pgliteDialect(history),
    plugins: [raceAfterHistoryWrite],
  });
  handles.published = [];
  race.next = null;
});

afterEach(async () => {
  await main.close();
  await history.close();
});

const stored = async (path = '/blocklists') =>
  (
    await main.query<{ roles: string[] }>(
      `SELECT roles FROM "AppPageAccess" WHERE app = 'moderator' AND path = $1`,
      [path]
    )
  ).rows[0]?.roles ?? null;
const historyRows = async () =>
  (
    await history.query<{
      actor_id: number;
      via: string;
      gate_ref: string | null;
      path: string;
      roles_before: string[];
      roles_after: string[];
      outcome: string;
    }>(
      `SELECT actor_id, via, gate_ref, path, roles_before, roles_after, outcome
       FROM page_access_change ORDER BY id`
    )
  ).rows;

const grantCm = (over: Partial<Parameters<typeof changePageRoles>[0]> = {}) =>
  changePageRoles({
    entries: [{ path: '/blocklists', roles: [HIGH, CM] }],
    userId: 42,
    via: 'api',
    gateRef: 'hub:request:test',
    expect: { '/blocklists': [HIGH] },
    ...over,
  });

describe('changePageRoles', () => {
  it('records the change, writes it, marks it applied, and republishes the cache', async () => {
    const { changed } = await grantCm();
    expect(changed).toEqual([{ path: '/blocklists', before: [HIGH], after: [HIGH, CM] }]);
    expect(await stored()).toEqual([HIGH, CM]);
    expect(await historyRows()).toEqual([
      {
        actor_id: 42,
        via: 'api',
        gate_ref: 'hub:request:test',
        path: '/blocklists',
        roles_before: [HIGH],
        roles_after: [HIGH, CM],
        outcome: 'applied',
      },
    ]);
    expect(JSON.parse(handles.published.at(-1)!)['/blocklists']).toEqual([HIGH, CM]);
  });

  it('refuses a stale `expect` with the current roles, and writes nothing anywhere', async () => {
    await expect(grantCm({ expect: { '/blocklists': [CM] } })).rejects.toMatchObject({
      constructor: GrantConflictError,
      current: [HIGH],
    });
    expect(await stored()).toEqual([HIGH]);
    expect(await historyRows()).toEqual([]);
  });

  it('compares roles as a set, not in stored order', async () => {
    await main.exec(
      `UPDATE "AppPageAccess" SET roles = ARRAY['${CM}', '${HIGH}'] WHERE path = '/blocklists'`
    );
    await changePageRoles({
      entries: [{ path: '/blocklists', roles: [] }],
      userId: 42,
      via: 'api',
      gateRef: 'g',
      expect: { '/blocklists': [HIGH, CM] },
    });
    expect(await stored()).toEqual([]);
  });

  it('does not write a grant it could not record', async () => {
    await history.exec('DROP TABLE page_access_change');
    await expect(grantCm()).rejects.toMatchObject({
      constructor: GrantHistoryUnavailableError,
      dbStatus: 'no-schema',
    });
    expect(await stored()).toEqual([HIGH]);
  });

  it('refuses a change that raced in after it was recorded, and records it refused', async () => {
    race.next = () =>
      main.exec(`UPDATE "AppPageAccess" SET roles = ARRAY[]::text[] WHERE path = '/blocklists'`);
    await expect(grantCm()).rejects.toBeInstanceOf(GrantConflictError);
    expect(await stored()).toEqual([]);
    expect(await historyRows()).toMatchObject([{ path: '/blocklists', outcome: 'refused' }]);
  });

  // Any failure but a conflict may have committed (a lost COMMIT acknowledgement looks the same), so
  // it must not be recorded as refused.
  it('leaves a write that failed for another reason unconfirmed, not refused', async () => {
    race.next = () => main.exec('DROP TABLE "AppPageAccess"');
    await expect(grantCm()).rejects.not.toBeInstanceOf(GrantConflictError);
    expect(await historyRows()).toMatchObject([{ path: '/blocklists', outcome: 'pending' }]);
  });

  it('records nothing for a change that changes nothing', async () => {
    const { changed } = await grantCm({
      entries: [{ path: '/blocklists', roles: [HIGH] }],
    });
    expect(changed).toEqual([]);
    expect(await historyRows()).toEqual([]);
  });

  it('treats a path with no row as granting nobody', async () => {
    await changePageRoles({
      entries: [{ path: '/decisions', roles: [CM] }],
      userId: 42,
      via: 'api',
      gateRef: 'g',
      expect: { '/decisions': [] },
    });
    expect(await stored('/decisions')).toEqual([CM]);
    expect(await historyRows()).toMatchObject([
      { path: '/decisions', roles_before: [], roles_after: [CM], outcome: 'applied' },
    ]);
  });
});

describe('/admin save', () => {
  const save = (changes: Record<string, string[]>, expected: Record<string, string[]>) => {
    const form = new FormData();
    form.set('changes', JSON.stringify(changes));
    form.set('expect', JSON.stringify(expected));
    const url = new URL('https://moderator.example.test/admin');
    return actions.save({
      request: new Request(url, { method: 'POST', body: form }),
      locals: { user: { id: 9, roles: ['moderator:admin'] } },
      url,
    } as never);
  };

  it('records one row per path it actually changes', async () => {
    const result = await save(
      { '/blocklists': [HIGH], '/decisions': [CM], '/xguard': [HIGH] },
      { '/blocklists': [HIGH], '/decisions': [], '/xguard': [] }
    );
    expect(result).toEqual({ success: true, count: 2 });
    expect(await historyRows()).toEqual([
      expect.objectContaining({
        via: 'admin-page',
        actor_id: 9,
        path: '/decisions',
        outcome: 'applied',
      }),
      expect.objectContaining({
        via: 'admin-page',
        actor_id: 9,
        path: '/xguard',
        outcome: 'applied',
      }),
    ]);
  });

  it('saves nothing when the history table is missing, and says so', async () => {
    await history.exec('DROP TABLE page_access_change');
    const result = await save({ '/decisions': [CM] }, { '/decisions': [] });
    expect(result).toMatchObject({ status: 503 });
    expect(await stored('/decisions')).toBeNull();
  });

  it('refuses, rather than reverts, a grant changed since the page loaded', async () => {
    // Loaded showing [HIGH]; the API then added CM; the operator saves their own edit.
    await main.exec(
      `UPDATE "AppPageAccess" SET roles = ARRAY['${HIGH}', '${CM}'] WHERE path = '/blocklists'`
    );
    const result = await save({ '/blocklists': [] }, { '/blocklists': [HIGH] });
    expect(result).toMatchObject({ status: 409 });
    expect(await stored()).toEqual([HIGH, CM]);
    expect(await historyRows()).toEqual([]);
  });

  it('refuses a save from a page that sent no expected roles', async () => {
    const form = new FormData();
    form.set('changes', JSON.stringify({ '/blocklists': [] }));
    const url = new URL('https://moderator.example.test/admin');
    const result = await actions.save({
      request: new Request(url, { method: 'POST', body: form }),
      locals: { user: { id: 9, roles: ['moderator:admin'] } },
      url,
    } as never);
    expect(result).toMatchObject({ status: 400 });
    expect(await stored()).toEqual([HIGH]);
  });

  it('compares what the page showed: a retired role still stored does not conflict', async () => {
    await main.exec(
      `UPDATE "AppPageAccess" SET roles = ARRAY['${HIGH}', 'moderator:retired'] WHERE path = '/blocklists'`
    );
    const result = await save({ '/blocklists': [] }, { '/blocklists': [HIGH] });
    expect(result).toEqual({ success: true, count: 1 });
    expect(await stored()).toEqual([]);
  });

  // A role outside the app's prefix (a service account's) is never a column on /admin, so the page
  // cannot send it back: the save has to keep it from the stored row.
  const SYSTEM = 'system:dispute-agent';
  const DISPUTE = 'grant:creatorServices.reviewDispute';

  it('keeps a role from outside the catalogue when the row is saved', async () => {
    await main.exec(
      `INSERT INTO "AppPageAccess" (app, path, roles) VALUES ('moderator', '${DISPUTE}', ARRAY['${HIGH}', '${SYSTEM}'])`
    );
    const result = await save({ [DISPUTE]: [HIGH, CM] }, { [DISPUTE]: [HIGH] });
    expect(result).toEqual({ success: true, count: 1 });
    expect(new Set(await stored(DISPUTE))).toEqual(new Set([HIGH, CM, SYSTEM]));
  });

  it('keeps it when every role the page shows is unticked', async () => {
    await main.exec(
      `INSERT INTO "AppPageAccess" (app, path, roles) VALUES ('moderator', '${DISPUTE}', ARRAY['${HIGH}', '${SYSTEM}'])`
    );
    const result = await save({ [DISPUTE]: [] }, { [DISPUTE]: [HIGH] });
    expect(result).toEqual({ success: true, count: 1 });
    expect(await stored(DISPUTE)).toEqual([SYSTEM]);
  });

  it('refuses, rather than reverts, a role outside the catalogue that moved mid-save', async () => {
    await main.exec(
      `INSERT INTO "AppPageAccess" (app, path, roles) VALUES ('moderator', '${DISPUTE}', ARRAY['${HIGH}'])`
    );
    race.next = () =>
      main.exec(
        `UPDATE "AppPageAccess" SET roles = ARRAY['${HIGH}', '${SYSTEM}'] WHERE path = '${DISPUTE}'`
      );
    const result = await save({ [DISPUTE]: [HIGH, CM] }, { [DISPUTE]: [HIGH] });
    expect(result).toMatchObject({ status: 409 });
    expect(await stored(DISPUTE)).toEqual([HIGH, SYSTEM]);
  });

  it('records what it kept and what it dropped apart from what the operator changed', async () => {
    await main.exec(
      `INSERT INTO "AppPageAccess" (app, path, roles) VALUES ('moderator', '${DISPUTE}', ARRAY['${HIGH}', '${SYSTEM}', 'moderator:retired'])`
    );
    await save({ [DISPUTE]: [CM] }, { [DISPUTE]: [HIGH] });
    expect(new Set(await stored(DISPUTE))).toEqual(new Set([CM, SYSTEM]));
    const rows = await history.query<{ roles_carried: string[]; roles_dropped: string[] }>(
      'SELECT roles_carried, roles_dropped FROM page_access_change'
    );
    expect(rows.rows).toEqual([{ roles_carried: [SYSTEM], roles_dropped: ['moderator:retired'] }]);
  });

  it('still refuses a role outside the catalogue sent by the page', async () => {
    const result = await save({ [DISPUTE]: [SYSTEM] }, { [DISPUTE]: [] });
    expect(result).toMatchObject({ status: 400 });
    expect(await stored(DISPUTE)).toBeNull();
  });
});

describe('page-access/schema.sql', () => {
  // The harness strips psql meta-commands to apply the file, so it cannot see the directive go missing.
  it('stops psql at the first failed statement', () => {
    expect(read('../../../../page-access/schema.sql')).toMatch(/^\\set ON_ERROR_STOP on$/m);
  });

  it('refuses an API row with no approval, and an unknown outcome', async () => {
    const insert = (via: string, gateRef: string | null, outcome = 'pending') =>
      history.query(
        `INSERT INTO page_access_change (actor_id, via, gate_ref, path, roles_before, roles_after, outcome)
         VALUES (1, $1, $2, '/x', '{}', '{}', $3)`,
        [via, gateRef, outcome]
      );
    await expect(insert('api', null)).rejects.toThrow(/page_access_change_api_gated/);
    await expect(insert('api', '  ')).rejects.toThrow(/page_access_change_api_gated/);
    await expect(insert('admin-page', null, 'done')).rejects.toThrow(/outcome_valid/);
    await expect(insert('admin-page', null)).resolves.toBeDefined();
  });
});
