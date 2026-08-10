import { REDIS_SYS_KEYS, createLruCache, type RedisKeyTemplateSys } from '@civitai/redis';
import {
  getPageAccessGrants,
  setPageAccessRoles,
  type PageAccessGrants,
} from '@civitai/db-queries/page-access';
import { APP } from './access';
import { dbRead, dbWrite } from './db';
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
  try {
    const cached = await getSysRedis().get(KEY);
    if (cached) return JSON.parse(cached) as PageAccessGrants;
  } catch (e) {
    console.error('[page-access] cache read failed, falling back to Postgres', e);
  }
  const grants = await getPageAccessGrants(dbRead, APP);
  try {
    await publish(grants);
  } catch (e) {
    console.error('[page-access] loaded from Postgres, but caching them failed', e);
  }
  return grants;
}

// The admin page edits grants, so it reads Postgres directly rather than the request cache — a stale or
// empty cache would render every checkbox blank and invite someone to "fix" it by re-saving, wiping the
// real grants. The gate can tolerate 30s of staleness; the editing surface cannot.
export function readPageAccessGrants(): Promise<PageAccessGrants> {
  return getPageAccessGrants(dbRead, APP);
}

export async function setPageRoles(input: {
  entries: { path: string; roles: string[] }[];
  userId: number;
}): Promise<void> {
  await setPageAccessRoles(dbWrite, { app: APP, ...input });

  // Postgres is the source of truth and the rows are already committed, so everything below is
  // best-effort: a cache failure must not report the save as failed. The memo is filled before the Redis
  // write so this server is correct even if Redis is down, and dropped on failure so the next request
  // re-reads rather than serving a map we are no longer sure about.
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
