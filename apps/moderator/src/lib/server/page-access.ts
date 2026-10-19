import { REDIS_SYS_KEYS, createLruCache, type RedisKeyTemplateSys } from '@civitai/redis';
import {
  getPageAccessGrants,
  setPageAccessRoles,
  type PageAccessGrants,
} from '@civitai/db-queries/page-access';
import {
  moderatorDbStatus,
  storeUnavailableMessage,
  type ModeratorDbStatus,
} from '$lib/moderator-db-status';
import { APP } from './access';
import { dbRead, dbWrite } from './db';
import { getModeratorDb } from './moderator-db';
import type { PageAccessChangeTables } from './page-access-change-tables';
import { getSysRedis } from './redis';

const KEY = `${REDIS_SYS_KEYS.APP.PAGE_ACCESS}:${APP}` as RedisKeyTemplateSys;
const REDIS_TTL_SECONDS = 300;
const MEMO_TTL_MS = 30_000;

// One entry, since there is one app's grants to hold. A failed load is never cached and `allowStale`
// serves the last good map through the outage: an empty map is indistinguishable from "nobody is granted
// anything", so returning one would revoke every non-admin moderator until the load recovered.
const memo = createLruCache<typeof APP, PageAccessGrants>({
  name: 'page-access',
  max: 1,
  ttl: MEMO_TTL_MS,
  allowStale: true,
  keyFn: (app) => app,
  fetchFn: readThrough,
});

// Read on every gated request, so it must never throw and never hit Postgres per request: in-process memo
// → sysRedis → Postgres. A write on one server is visible to the others within MEMO_TTL_MS.
//
// `{}` only where there is genuinely nothing to serve — a process whose FIRST load failed. That still
// denies every non-admin, so the log line is the one to look for when a tier reports an empty sidebar.
export async function loadPageAccessGrants(): Promise<PageAccessGrants> {
  try {
    return await memo.fetch(APP);
  } catch (e) {
    console.error('[page-access] load failed and no grants have ever loaded', e);
    return {};
  }
}

// Postgres is the source of truth, so a sysRedis failure must not discard a read that succeeded: the
// publish is best-effort AFTER the grants are in hand. Throwing here instead would leave `memo` empty and
// revoke every non-admin's page access for as long as sysRedis was down, while admins — who bypass grants
// entirely — saw nothing wrong. A cache read that throws falls through to Postgres for the same reason.
async function readThrough(): Promise<PageAccessGrants> {
  let cached: PageAccessGrants | null = null;
  try {
    const raw = await getSysRedis().get(KEY);
    if (raw) cached = JSON.parse(raw) as PageAccessGrants;
  } catch (e) {
    console.error('[page-access] cache read failed, falling back to Postgres', e);
  }
  if (cached) return cached;

  const grants = await getPageAccessGrants(dbRead, APP);
  try {
    await publish(grants);
  } catch (e) {
    console.error('[page-access] loaded grants, but caching them failed', e);
  }
  return grants;
}

// The admin page edits grants, so it reads Postgres directly rather than the request cache — a stale or
// empty cache would render every checkbox blank and invite someone to "fix" it by re-saving, wiping the
// real grants. The gate can tolerate 30s of staleness; the editing surface cannot.
export function readPageAccessGrants(): Promise<PageAccessGrants> {
  return getPageAccessGrants(dbRead, APP);
}

/** A path's stored roles moved after the caller read them. Nothing was written. */
export class GrantConflictError extends Error {
  constructor(readonly path: string, readonly current: string[]) {
    super(`${path} changed since it was read: it now grants ${current.join(', ') || 'nobody'}.`);
  }
}

export const historyUnavailableMessage = (status: Exclude<ModeratorDbStatus, 'ok'>) =>
  storeUnavailableMessage(status, {
    tables: 'The permission history table',
    database: 'the moderator database',
    schemaFile: 'apps/moderator/page-access/schema.sql',
  });

/** The history table could not be written, so the grant was not either. */
export class GrantHistoryUnavailableError extends Error {
  constructor(readonly status: Exclude<ModeratorDbStatus, 'ok'>) {
    super(`${historyUnavailableMessage(status)} No grant was changed.`);
  }
}

const history = () => getModeratorDb().withTables<PageAccessChangeTables>();

// Order-blind: the stored array's order means nothing, and a caller restating it in another order has
// not described a different grant.
const sameRoles = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((role) => right.has(role));
};

/**
 * The one write path for grants, used by `/admin` and by the API, so neither can change a grant without
 * leaving a history row. Paths whose roles would not change are skipped and recorded nowhere.
 *
 * Order matters and is the point: history row → grant → mark the row applied. A grant that cannot be
 * recorded does not happen. The rows are re-checked under a row lock inside the write, so the `before`
 * a history row states is what the write replaced, and a change that raced in between is refused with
 * `GrantConflictError` rather than silently overwritten.
 */
export async function changePageRoles(input: {
  entries: { path: string; roles: string[] }[];
  userId: number;
  via: PageAccessChangeTables['page_access_change']['via'];
  gateRef?: string | null;
  reason?: string | null;
  /** Compare-and-set: each path's roles as the caller last read them. */
  expect?: Record<string, string[]>;
}): Promise<{ changed: { path: string; before: string[]; after: string[] }[] }> {
  const stored = await getPageAccessGrants(dbWrite, APP);
  const before = (path: string) => stored[path] ?? [];
  for (const [path, roles] of Object.entries(input.expect ?? {}))
    if (!sameRoles(before(path), roles)) throw new GrantConflictError(path, before(path));

  const changed = input.entries
    .filter((entry) => !sameRoles(before(entry.path), entry.roles))
    .map((entry) => ({ path: entry.path, before: before(entry.path), after: entry.roles }));
  if (!changed.length) return { changed };

  let ids: string[];
  try {
    const rows = await history()
      .insertInto('page_access_change')
      .values(
        changed.map((c) => ({
          actor_id: input.userId,
          via: input.via,
          gate_ref: input.gateRef ?? null,
          path: c.path,
          roles_before: c.before,
          roles_after: c.after,
          reason: input.reason ?? null,
        }))
      )
      .returning('id')
      .execute();
    ids = rows.map((r) => r.id);
  } catch (e) {
    console.error('[page-access] could not record the change, so it was not made', e);
    throw new GrantHistoryUnavailableError(moderatorDbStatus(e));
  }

  await dbWrite.transaction().execute(async (trx) => {
    const locked = await trx
      .selectFrom('AppPageAccess')
      .select(['path', 'roles'])
      .where('app', '=', APP)
      .where(
        'path',
        'in',
        changed.map((c) => c.path)
      )
      .forUpdate()
      .execute();
    const now = new Map(locked.map((row) => [row.path, row.roles]));
    for (const c of changed)
      if (!sameRoles(now.get(c.path) ?? [], c.before))
        throw new GrantConflictError(c.path, now.get(c.path) ?? []);
    await setPageAccessRoles(trx, {
      app: APP,
      userId: input.userId,
      entries: changed.map((c) => ({ path: c.path, roles: c.after })),
    });
  });

  // The grant is committed; failing the request now would invite a retry that the compare-and-set
  // refuses. The row stays `applied = false`, which the history shows as unconfirmed.
  try {
    await history()
      .updateTable('page_access_change')
      .set({ applied: true })
      .where('id', 'in', ids)
      .execute();
  } catch (e) {
    console.error(
      '[page-access] grant written, but marking its history rows applied failed',
      ids,
      e
    );
  }

  await refreshCache();
  return { changed };
}

export type PageAccessChange = {
  id: string;
  at: Date;
  actorId: number;
  via: PageAccessChangeTables['page_access_change']['via'];
  gateRef: string | null;
  path: string;
  before: string[];
  after: string[];
  reason: string | null;
  applied: boolean;
};

export function listPageAccessChanges(limit: number): Promise<PageAccessChange[]> {
  return history()
    .selectFrom('page_access_change')
    .select([
      'id',
      'at',
      'actor_id as actorId',
      'via',
      'gate_ref as gateRef',
      'path',
      'roles_before as before',
      'roles_after as after',
      'reason',
      'applied',
    ])
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

// Postgres is the source of truth and the rows are already committed, so this is best-effort: a cache
// failure must not report the save as failed. The memo is filled before the Redis write so this server
// is correct even if Redis is down, and dropped on failure so the next request re-reads rather than
// serving a map we are no longer sure about.
async function refreshCache(): Promise<void> {
  try {
    const grants = await getPageAccessGrants(dbWrite, APP);
    memo.set(APP, grants);
    await publish(grants);
  } catch (e) {
    memo.delete(APP);
    console.error('[page-access] saved, but refreshing the cache failed', e);
  }
}

async function publish(grants: PageAccessGrants): Promise<PageAccessGrants> {
  await getSysRedis().set(KEY, JSON.stringify(grants), { EX: REDIS_TTL_SECONDS });
  return grants;
}
