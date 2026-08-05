import { REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
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

let memo: PageAccessGrants = {};
let memoUntil = 0;

// Read on every gated request, so it must never throw and never hit Postgres per request: in-process memo
// → sysRedis → Postgres. On failure the last known map stands (initially empty = the committed defaults).
// A write on one server is visible to the others within MEMO_TTL_MS.
export async function loadPageAccessGrants(): Promise<PageAccessGrants> {
  if (Date.now() < memoUntil) return memo;
  memoUntil = Date.now() + MEMO_TTL_MS;
  try {
    memo = await readThrough();
  } catch (e) {
    console.error('[page-access] load failed, keeping last known grants', e);
  }
  return memo;
}

async function readThrough(): Promise<PageAccessGrants> {
  const cached = await getSysRedis().get(KEY);
  if (cached) return JSON.parse(cached) as PageAccessGrants;
  return publish(await getPageAccessGrants(dbRead, APP));
}

export async function setPageRoles(input: {
  entries: { path: string; roles: string[] }[];
  userId: number;
}): Promise<void> {
  await setPageAccessRoles(dbWrite, { app: APP, ...input });

  // Postgres is the source of truth and the rows are already committed, so everything below is
  // best-effort: a cache failure must not report the save as failed. `memo` is set before the Redis
  // write so this server is correct even if Redis is down, and the memo is expired on failure so the
  // next request re-reads rather than serving a map we are no longer sure about.
  try {
    const grants = await getPageAccessGrants(dbWrite, APP);
    memo = grants;
    memoUntil = Date.now() + MEMO_TTL_MS;
    await publish(grants);
  } catch (e) {
    memoUntil = 0;
    console.error('[page-access] saved, but refreshing the cache failed', e);
  }
}

async function publish(grants: PageAccessGrants): Promise<PageAccessGrants> {
  await getSysRedis().set(KEY, JSON.stringify(grants), { EX: REDIS_TTL_SECONDS });
  return grants;
}
