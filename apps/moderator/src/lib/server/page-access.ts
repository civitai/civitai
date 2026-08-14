import { REDIS_SYS_KEYS, createLruCache, type RedisKeyTemplateSys } from '@civitai/redis';
import {
  getPageAccessGrants,
  insertMissingPageAccess,
  setPageAccessRoles,
  type PageAccessGrants,
} from '@civitai/db-queries/page-access';
import { APP, missingCapabilityRows } from './access';
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
  let cached: PageAccessGrants | null = null;
  try {
    const raw = await getSysRedis().get(KEY);
    if (raw) cached = JSON.parse(raw) as PageAccessGrants;
  } catch (e) {
    console.error('[page-access] cache read failed, falling back to Postgres', e);
  }
  // The cheap check runs on the cache hit too. Returning early would leave a freshly deployed capability
  // unseeded — and therefore admin-only — until the Redis entry expired, which is the whole window the
  // deploy was supposed to close.
  if (cached && !missingCapabilityRows(cached).length) return cached;

  const grants = await seedNewCapabilities(cached ?? (await getPageAccessGrants(dbRead, APP)));
  try {
    await publish(grants);
  } catch (e) {
    console.error('[page-access] loaded grants, but caching them failed', e);
  }
  return grants;
}

/**
 * Writes the declared default for any capability that has no row at all, so shipping a new one does not
 * silently revoke everybody until a human remembers to run SQL against each environment. That failure was
 * invisible — no error, no log, just moderators quietly unable to act — and it recurred once per
 * capability.
 *
 * Only ever INSERTs, and only where nothing is stored. A row that exists is a decision, including one
 * granting nobody, so `/admin` stays the authority from the first save onward. Costs one comparison in
 * the steady state: after a deploy seeds them, nothing is missing and this does no work.
 *
 * Best-effort — a failure leaves the capability admin-only and the next load tries again, which is the
 * same fail-closed state as an unseeded environment. It must not take down the request that triggered it.
 */
async function seedNewCapabilities(grants: PageAccessGrants): Promise<PageAccessGrants> {
  const missing = missingCapabilityRows(grants);
  if (!missing.length) return grants;
  try {
    const created = await insertMissingPageAccess(dbWrite, {
      app: APP,
      // Nobody performed this; attributing it to a moderator would put a name on a grant they never made.
      userId: null,
      entries: missing,
    });
    console.info(`[page-access] seeded ${created} newly declared capabilit(ies) with their defaults`);
    return await getPageAccessGrants(dbWrite, APP);
  } catch (e) {
    console.error('[page-access] could not seed newly declared capabilities', e);
    return grants;
  }
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
