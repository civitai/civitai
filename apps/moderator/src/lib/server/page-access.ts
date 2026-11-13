import { REDIS_SYS_KEYS, createLruCache, type RedisKeyTemplateSys } from '@civitai/redis';
import {
  getPageAccessGrants,
  lockPageAccessGrants,
  setPageAccessRoles,
  type PageAccessGrants,
} from '@civitai/db-queries/page-access';
import {
  moderatorDbStatus,
  storeUnavailableMessage,
  type ModeratorDbStatus,
} from '$lib/moderator-db-status';
import { APP, isAppRole } from './access';
import { dbRead, dbWrite } from './db';
import { getModeratorDb } from './moderator-db';
import type {
  PageAccessChangeTables,
  PageAccessOutcome,
  PageAccessVia,
} from './page-access-change-tables';
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
  readonly status = 409;
  constructor(readonly path: string, readonly current: string[]) {
    super(`${path} changed since it was read: it now grants ${current.join(', ') || 'nobody'}.`);
  }
}

export const historyUnavailableMessage = (status: Exclude<ModeratorDbStatus, 'ok'>) =>
  storeUnavailableMessage(status, {
    tables: 'The tables for permission history',
    database: 'the moderator database',
    schemaFile: 'apps/moderator/page-access/schema.sql',
  });

/** The history table could not be written, so the grant was not either. */
export class GrantHistoryUnavailableError extends Error {
  readonly status = 503;
  constructor(readonly dbStatus: Exclude<ModeratorDbStatus, 'ok'>) {
    super(`${historyUnavailableMessage(dbStatus)} No grant was changed.`);
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

async function setOutcome(ids: string[], outcome: PageAccessOutcome): Promise<void> {
  try {
    await history()
      .updateTable('page_access_change')
      .set({ outcome })
      .where('id', 'in', ids)
      .execute();
  } catch (e) {
    console.error(`[page-access] could not mark history rows ${outcome}`, ids, e);
  }
}

/**
 * The one write path for grants, used by `/admin` and by the API, so neither can change a grant without
 * leaving a history row. Paths whose roles would not change are skipped and recorded nowhere.
 *
 * Order is the point: history row → grant → outcome. A grant that cannot be recorded does not happen.
 * The grant is re-read under the app's grant lock before it is written, so a history row's `before` is
 * what the write replaced, and anything that moved since is refused with `GrantConflictError`.
 */
export async function changePageRoles(input: {
  entries: { path: string; roles: string[] }[];
  userId: number;
  via: PageAccessVia;
  gateRef?: string | null;
  reason?: string | null;
  /** Compare-and-set: each path's roles as the caller last read them. */
  expect?: Record<string, string[]>;
  /**
   * The roles the caller edits: `/admin`'s live catalogue. Each entry then states only these, and `expect`
   * is compared against the stored roles narrowed to them. Every other stored role is the server's to
   * carry: kept, unless it is a retired role of this app's own (`isAppRole`), which is dropped. Taken from
   * the stored row rather than the page, which cannot show them and would otherwise erase them.
   */
  manages?: readonly string[];
}): Promise<{ changed: { path: string; before: string[]; after: string[] }[] }> {
  const stored = await getPageAccessGrants(dbWrite, APP);
  const before = (path: string) => stored[path] ?? [];
  const { manages } = input;
  const unmanaged = (roles: string[]) =>
    manages ? [...new Set(roles)].filter((r) => !manages.includes(r)) : [];
  const carried = (path: string) => unmanaged(before(path)).filter((r) => !isAppRole(r));
  const dropped = (path: string) => unmanaged(before(path)).filter(isAppRole);
  const comparable = (roles: string[]) =>
    manages ? roles.filter((r) => manages.includes(r)) : roles;
  for (const [path, roles] of Object.entries(input.expect ?? {}))
    if (!sameRoles(comparable(before(path)), roles))
      throw new GrantConflictError(path, before(path));

  const changed = input.entries
    .map((entry) => ({
      path: entry.path,
      before: before(entry.path),
      after: [...new Set([...entry.roles, ...carried(entry.path)])],
      carried: carried(entry.path),
      dropped: dropped(entry.path),
    }))
    .filter((c) => !sameRoles(c.before, c.after));
  if (!changed.length) return { changed: [] };

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
          roles_carried: c.carried,
          roles_dropped: c.dropped,
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

  try {
    await dbWrite.transaction().execute(async (trx) => {
      const now = await lockPageAccessGrants(
        trx,
        APP,
        changed.map((c) => c.path)
      );
      for (const c of changed)
        if (!sameRoles(now[c.path] ?? [], c.before))
          throw new GrantConflictError(c.path, now[c.path] ?? []);
      await setPageAccessRoles(trx, {
        app: APP,
        userId: input.userId,
        entries: changed.map((c) => ({ path: c.path, roles: c.after })),
      });
    });
  } catch (e) {
    // Only a conflict is known not to have landed: any other failure, a lost COMMIT acknowledgement
    // included, may have written the grant, so its rows stay `pending` (unconfirmed).
    if (e instanceof GrantConflictError) await setOutcome(ids, 'refused');
    throw e;
  }

  // The grant is committed; failing the request now would invite a retry the compare-and-set refuses.
  await setOutcome(ids, 'applied');
  await refreshCache();
  return { changed: changed.map(({ path, before, after }) => ({ path, before, after })) };
}

export type PageAccessChange = {
  id: string;
  at: Date;
  actorId: number;
  via: PageAccessVia;
  gateRef: string | null;
  path: string;
  before: string[];
  after: string[];
  reason: string | null;
  outcome: PageAccessOutcome;
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
      'outcome',
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
