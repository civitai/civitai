import { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  redis,
  REDIS_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';
import type { TagsOnTagsType } from '~/shared/utils/prisma/enums';
import { TagType } from '~/shared/utils/prisma/enums';
import { createTtlMemo } from '~/server/utils/ttl-memoize';
import { indexOfOr } from '~/utils/array-helpers';
import { createLogger } from '~/utils/logging';
import { isDefined } from '~/utils/type-guards';
import type { LiveFeatureFlags } from '../common/constants';
import { DEFAULT_LIVE_FEATURE_FLAGS } from '../common/constants';
import {
  BLOCKED_BROWSING_TAG_IDS,
  DEFAULT_BROWSING_SETTINGS_ADDONS,
} from '~/shared/constants/browsing-settings-addons';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';

const log = createLogger('system-cache', 'green');

const SYSTEM_CACHE_EXPIRY = 60 * 60 * 4;

// In-process (per-pod) memoize TTL for the GLOBAL, user-independent system-cache
// blobs below. These values are identical for every user/request, and the backing
// redis blob itself already only changes ~every SYSTEM_CACHE_EXPIRY (4h). Putting a
// short in-proc TTL in front of them collapses a redis GET (+ an msgpackr decode for
// the packed MODERATED_TAGS) on every call into ~1 read / TTL / pod — mirroring the
// live `getClientConfigCached` pattern in src/server/trpc.ts. Only successful reads
// are memoized (a fetcher rejection propagates uncached; see createTtlMemo), so each
// getter's existing fail-open/fail-safe behavior is preserved.
//
// Staleness tradeoff: the moderation-sensitive blobs (MODERATED_TAGS,
// BLOCKED_BROWSING_TAGS, BROWSING_SETTING_ADDONS) gate which tags/content are hidden,
// so a newly-moderated tag or a flipped browsing addon takes up to this TTL *longer*
// to propagate, PER POD, on top of the already-4h redis staleness. Kept short (30s)
// so that marginal delay is trivial. None of these keys are `redis.del`-invalidated
// (verified), so the in-proc layer cannot shadow an intended prompt invalidation.
const SYSTEM_CACHE_INPROC_TTL_MS = 30_000;

// LIVE_FEATURE_FLAGS behaves like an operational toggle (ops can flip a feature on/off
// via sysRedis), so it gets a shorter TTL than the content blobs — matching
// CLIENT_CONFIG_TTL_MS — to keep flag-flip propagation fast (<=5s/pod) while still
// collapsing the per-call sysRedis GET on the generation/feature-flag hot path.
const LIVE_FLAGS_INPROC_TTL_MS = 5_000;

export type SystemModerationTag = {
  id: number;
  name: string;
  nsfwLevel: NsfwLevel;
  parentId?: number;
};
// Hottest of the global blobs: fetched on the feed hidden-preferences path
// (user-preferences.service.ts) and re-decoded via msgpackr on every call. The
// in-proc memo cuts both the redis GET and the msgpackr decode per call. This
// key is NOT redis.del-invalidated anywhere (only the 4h EX), so the extra
// in-proc TTL is purely additive to the already-eventual 4h staleness.
const getModeratedTagsMemo = createTtlMemo<SystemModerationTag[]>(async () => {
  const cachedTags = await redis.packed.get<SystemModerationTag[]>(
    REDIS_KEYS.SYSTEM.MODERATED_TAGS
  );
  if (cachedTags) return cachedTags;

  log('getting moderation tags');
  const tags = await dbRead.tag.findMany({
    where: { nsfwLevel: { gt: NsfwLevel.PG } },
    select: { id: true, name: true, nsfwLevel: true },
  });

  const tagsOnTags = await dbRead.tagsOnTags.findMany({
    where: { fromTagId: { in: tags.map((x) => x.id) }, type: 'Parent' },
    select: { fromTagId: true, toTag: { select: { id: true, name: true } } },
  });

  const normalizedTagsOnTags = tagsOnTags
    .map(({ fromTagId, toTag }) => {
      const parentTag = tags.find((x) => x.id === fromTagId);
      if (!parentTag) return null;
      return { ...toTag, nsfwLevel: parentTag.nsfwLevel, parentId: fromTagId };
    })
    .filter(isDefined);

  const combined: SystemModerationTag[] = [...tags, ...normalizedTagsOnTags];

  await redis.packed.set(REDIS_KEYS.SYSTEM.MODERATED_TAGS, combined, {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got moderation tags');
  return combined;
}, SYSTEM_CACHE_INPROC_TTL_MS);

export async function getModeratedTags(): Promise<SystemModerationTag[]> {
  return getModeratedTagsMemo();
}

export type TagRule = {
  fromId: number;
  toId: number;
  fromTag: string;
  toTag: string;
  type: TagsOnTagsType;
  createdAt: Date;
};
export async function getTagRules() {
  const cached = await redis.get(REDIS_KEYS.SYSTEM.TAG_RULES);
  if (cached) return JSON.parse(cached) as TagRule[];

  log('getting tag rules');
  const rules = await dbWrite.$queryRaw<TagRule[]>`
    SELECT
      "fromTagId" as "fromId",
      "toTagId" as "toId",
      f."name" as "fromTag",
      t."name" as "toTag",
      tot.type,
      tot."createdAt"
    FROM "TagsOnTags" tot
    JOIN "Tag" f ON f."id" = tot."fromTagId"
    JOIN "Tag" t ON t."id" = tot."toTagId"
    WHERE tot.type IN ('Replace', 'Append')
  `;
  await redis.set(REDIS_KEYS.SYSTEM.TAG_RULES, JSON.stringify(rules), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got tag rules');
  return rules;
}

export async function getSystemTags() {
  const cachedTags = await redis.get(REDIS_KEYS.SYSTEM.SYSTEM_TAGS);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting system tags');
  const tags = await dbWrite.tag.findMany({
    where: { type: TagType.System },
    select: { id: true, name: true },
  });
  await redis.set(REDIS_KEYS.SYSTEM.SYSTEM_TAGS, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got system tags');
  return tags;
}

export async function getReplacedTagIds(): Promise<number[]> {
  const tagRules = await getTagRules();
  return tagRules.filter((rule) => rule.type === 'Replace').map((rule) => rule.toId);
}

export async function getSystemPermissions(): Promise<Record<string, number[]>> {
  // Throws on sysRedis error. Callers decide fail-open behavior:
  //   - the hub's produceSessionUser (session-producer.ts) skips the
  //     SessionUser cache write on error, to avoid poisoning the cache
  //     with empty permissions for hours after sysRedis recovers.
  //   - addSystemPermission / removeSystemPermission MUST throw to avoid
  //     overwriting the real permission set with a partial mutation
  //     (read returns {} during outage, write later succeeds → wipe).
  // Wall-clock deadline so a silent sysRedis half-open can't park this read (reached
  // per-request on a session-cache miss; the sys client has no socketTimeout and a
  // per-command timeout can't abort a written command). On timeout it throws — which
  // preserves this function's throw-on-error contract for all callers.
  const cachedPermissions = await withSysReadDeadline(
    sysRedis.get(REDIS_SYS_KEYS.SYSTEM.PERMISSIONS)
  );
  if (cachedPermissions) return JSON.parse(cachedPermissions);

  return {};
}

export async function addSystemPermission(permission: FeatureFlagKey, userIds: number | number[]) {
  userIds = Array.isArray(userIds) ? userIds : [userIds];
  const permissions = await getSystemPermissions();
  if (!permissions[permission]) permissions[permission] = [];
  permissions[permission] = [...new Set([...permissions[permission], ...userIds])];
  await sysRedis.set(REDIS_SYS_KEYS.SYSTEM.PERMISSIONS, JSON.stringify(permissions));
}

export async function removeSystemPermission(
  permission: FeatureFlagKey,
  userIds: number | number[]
) {
  userIds = Array.isArray(userIds) ? userIds : [userIds];
  const permissions = await getSystemPermissions();
  if (!permissions[permission]) return;

  permissions[permission] = permissions[permission].filter(
    (x) => !(userIds as number[]).includes(x)
  );
  await sysRedis.set(REDIS_SYS_KEYS.SYSTEM.PERMISSIONS, JSON.stringify(permissions));
}

const colorPriority = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'brown',
  'grey',
];

export async function getCategoryTags(type: 'image' | 'model' | 'post' | 'article' | 'model3d') {
  let categories: TypeCategory[] | undefined;
  const categoriesCache = await redis.get(`${REDIS_KEYS.SYSTEM.CATEGORIES}:${type}`);
  if (categoriesCache) categories = JSON.parse(categoriesCache);

  if (!categories) {
    const systemTags = await getSystemTags();
    const categoryTag = systemTags.find((t) => t.name === `${type} category`);
    if (!categoryTag) throw new Error(`${type} category tag not found`);
    const categoriesRaw = await dbWrite.tag.findMany({
      where: { fromTags: { some: { fromTagId: categoryTag.id } } },
      select: { id: true, name: true, color: true, adminOnly: true },
    });
    categories = categoriesRaw
      .map((c) => ({
        id: c.id,
        name: c.name,
        adminOnly: c.adminOnly,
        priority: indexOfOr(colorPriority, c.color ?? 'grey', colorPriority.length),
      }))
      .sort((a, b) => a.priority - b.priority);
    if (categories.length)
      await redis.set(`${REDIS_KEYS.SYSTEM.CATEGORIES}:${type}`, JSON.stringify(categories));
  }

  return categories;
}

// export async function getTagsNeedingReview() {
//   const cachedTags = await redis.get(REDIS_KEYS.SYSTEM.TAGS_NEEDING_REVIEW);
//   if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

//   log('getting tags needing review');
//   const tags = await dbWrite.tag.findMany({
//     where: { name: { in: tagsNeedingReview } },
//     select: { id: true, name: true },
//   });

//   await redis.set(REDIS_KEYS.SYSTEM.TAGS_NEEDING_REVIEW, JSON.stringify(tags), {
//     EX: SYSTEM_CACHE_EXPIRY,
//   });

//   log('got tags needing review');
//   return tags;
// }

// Hard navigation blocklist (W2). Seeded from BLOCKED_BROWSING_TAG_IDS; ops
// override the live set by writing a JSON `{id, name}[]` to the redis key.
// Names resolved from the DB (lowercase) so W2 name matching + tag-page 404 work.
// Global navigation blocklist on the hot feed + tag-page path. Resolves to a
// real value (redis hit, or a DB fetch that rewrites the key) or throws on a
// redis/DB failure — it never swallows an error into an empty list — so the
// in-proc memo only ever caches a genuine value. Not redis.del-invalidated.
const getBlockedBrowsingTagsMemo = createTtlMemo<{ id: number; name: string }[]>(async () => {
  const cached = await redis.get(REDIS_KEYS.SYSTEM.BLOCKED_BROWSING_TAGS);
  if (cached) {
    // Fail open on a corrupt ops-set value (this getter is on the hot feed +
    // tag-page path); fall through to the DB fetch, which rewrites the key.
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed as { id: number; name: string }[];
    } catch (err) {
      logSysRedisFailOpen('read-degraded', 'getBlockedBrowsingTags', err, {
        cachedSample: cached.slice(0, 64),
      });
    }
  }

  log('getting blocked browsing tags');
  const tags = await dbRead.tag.findMany({
    where: { id: { in: BLOCKED_BROWSING_TAG_IDS } },
    select: { id: true, name: true },
  });
  await redis.set(REDIS_KEYS.SYSTEM.BLOCKED_BROWSING_TAGS, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got blocked browsing tags');
  return tags;
}, SYSTEM_CACHE_INPROC_TTL_MS);

export async function getBlockedBrowsingTags(): Promise<{ id: number; name: string }[]> {
  return getBlockedBrowsingTagsMemo();
}

// Global, effectively static (['woman', 'women']) home-page tag exclusion.
// Not redis.del-invalidated; resolves to a real value or throws.
const getHomeExcludedTagsMemo = createTtlMemo<{ id: number; name: string }[]>(async () => {
  const cachedTags = await redis.get(REDIS_KEYS.SYSTEM.HOME_EXCLUDED_TAGS);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting home excluded tags');
  const tags = await dbWrite.tag.findMany({
    where: { name: { in: ['woman', 'women'] } },
    select: { id: true, name: true },
  });
  await redis.set(REDIS_KEYS.SYSTEM.HOME_EXCLUDED_TAGS, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got home excluded tags');
  return tags;
}, SYSTEM_CACHE_INPROC_TTL_MS);

export async function getHomeExcludedTags() {
  return getHomeExcludedTagsMemo();
}

export async function setLiveNow(isLive: boolean) {
  await redis.set(REDIS_KEYS.LIVE_NOW, isLive ? 'true' : 'false');
}

export async function getLiveNow() {
  const cachedLiveNow = await redis.get(REDIS_KEYS.LIVE_NOW);
  return cachedLiveNow === 'true';
}

// In-proc memo over the RAW sysRedis string only — the try/catch + JSON.parse
// fail-open below stay OUTSIDE the memo so semantics are byte-for-byte preserved:
// a redis error/timeout rejects (→ NOT cached → outer catch fails open to
// defaults), while an unset key (null) or a real string IS cached. This is an
// SSR every-render read, so collapsing the per-render sysRedis GET into ~1/TTL/pod
// is the win; parsing the small cached string per call is negligible.
const getBrowsingSettingAddonsRawMemo = createTtlMemo<string | null>(
  () => withSysReadDeadline(sysRedis.get(REDIS_SYS_KEYS.SYSTEM.BROWSING_SETTING_ADDONS)),
  SYSTEM_CACHE_INPROC_TTL_MS
);

export async function getBrowsingSettingAddons() {
  let cached: string | null = null;
  try {
    // Wall-clock deadline: this is an SSR every-render read (via _app.tsx
    // getInitialProps). Without the race a silent sysRedis half-open parks
    // the awaited get ~11min on EVERY page render; the try/catch below only
    // covers a fast DOWN reject. On timeout the deadline rejects into the
    // catch → fail open to defaults.
    cached = await getBrowsingSettingAddonsRawMemo();
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getBrowsingSettingAddons', err);
    return DEFAULT_BROWSING_SETTINGS_ADDONS;
  }
  if (cached) {
    try {
      return JSON.parse(cached) as BrowsingSettingsAddon[];
    } catch (err) {
      // Corrupt/non-JSON value in sysRedis (e.g. a malformed value set by
      // an ops tool). Without this guard the parse throws all the way up
      // through _app.tsx getInitialProps and 500s every page render.
      // Fail open to defaults — same posture as the read above and
      // getCreationBlockedTags below.
      logSysRedisFailOpen('read-degraded', 'getBrowsingSettingAddons', err, {
        cachedSample: cached.slice(0, 64),
      });
      return DEFAULT_BROWSING_SETTINGS_ADDONS;
    }
  }

  return DEFAULT_BROWSING_SETTINGS_ADDONS;
}

export type CreationBlockedTag = { id: number; name: string };
// Tags that creators cannot apply to their own models. Stored verbatim in
// sysRedis key `system:creation-blocked-tags` as a JSON array of
// `{id, name}` objects. No in-code default — when unset, no tags are blocked.
// Independent of BrowsingSettingsAddons (addons gate viewing, this gates
// authoring). Ops seed/update via `/api/admin/creation-blocked-tags`.
export async function getCreationBlockedTags(): Promise<CreationBlockedTag[]> {
  // Fail open: called on every model upsert (ModelUpsertForm tRPC) and
  // from model.controller.ts. A sysRedis outage would otherwise 500
  // every model upload. Empty list matches the unset-key behavior — no
  // tags blocked during the outage window.
  let raw: string | null = null;
  try {
    // Wall-clock deadline: called on every model upsert (ModelUpsertForm
    // tRPC) + model.controller.ts, so a silent sysRedis half-open would park
    // this awaited get ~11min on the upload path; the try/catch only covers a
    // fast DOWN reject. On timeout the deadline rejects into the catch →
    // fail open to the empty (no-tags-blocked) list.
    raw = await withSysReadDeadline(sysRedis.get(REDIS_SYS_KEYS.SYSTEM.CREATION_BLOCKED_TAGS));
  } catch (err) {
    logSysRedisFailOpen('defaults-firing', 'getCreationBlockedTags', err);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is CreationBlockedTag => !!x && typeof x.id === 'number' && typeof x.name === 'string'
    );
  } catch {
    return [];
  }
}

async function resolveBlockedTags(tagIds: number[]): Promise<CreationBlockedTag[]> {
  const uniqueIds = Array.from(new Set(tagIds.filter((x) => Number.isInteger(x) && x > 0)));
  if (!uniqueIds.length) return [];
  const rows = await dbRead.tag.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true },
  });
  // Preserve caller's order when possible
  const byId = new Map(rows.map((r) => [r.id, r]));
  return uniqueIds.map((id) => byId.get(id)).filter((x): x is CreationBlockedTag => !!x);
}

export async function setCreationBlockedTags(tagIds: number[]): Promise<CreationBlockedTag[]> {
  const tags = await resolveBlockedTags(tagIds);
  await sysRedis.set(REDIS_SYS_KEYS.SYSTEM.CREATION_BLOCKED_TAGS, JSON.stringify(tags));
  return tags;
}

// Throws on sysRedis error so a read failure during a flap can't combine
// with a successful write to wipe the existing list. Admin retries after
// recovery. Bypasses the fail-open getCreationBlockedTags() above.
async function getCreationBlockedTagsRaw(): Promise<CreationBlockedTag[]> {
  const raw = await sysRedis.get(REDIS_SYS_KEYS.SYSTEM.CREATION_BLOCKED_TAGS);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (x): x is CreationBlockedTag => !!x && typeof x.id === 'number' && typeof x.name === 'string'
  );
}

export async function addCreationBlockedTags(tagIds: number[]): Promise<CreationBlockedTag[]> {
  const current = await getCreationBlockedTagsRaw();
  const currentIds = new Set(current.map((t) => t.id));
  const newIds = tagIds.filter((id) => !currentIds.has(id));
  if (!newIds.length) return current;
  return setCreationBlockedTags([...current.map((t) => t.id), ...newIds]);
}

export async function removeCreationBlockedTags(tagIds: number[]): Promise<CreationBlockedTag[]> {
  const current = await getCreationBlockedTagsRaw();
  const toRemove = new Set(tagIds);
  return setCreationBlockedTags(current.map((t) => t.id).filter((id) => !toRemove.has(id)));
}

// In-proc memo over the RAW sysRedis string only, with a SHORTER TTL than the
// content blobs (operational toggle → fast flag-flip propagation). The try/catch
// + JSON.parse stay OUTSIDE the memo so semantics are preserved exactly: a redis
// error/timeout rejects (→ NOT cached → outer catch fails open to defaults);
// unset (null) or a real string IS cached; a corrupt value still throws out of
// JSON.parse below just as before. Evaluated on the generation/feature-flag hot
// path, so collapsing the per-call sysRedis GET into ~1/TTL/pod is the win.
const getLiveFeatureFlagsRawMemo = createTtlMemo<string | null>(
  () => withSysReadDeadline(sysRedis.get(REDIS_SYS_KEYS.SYSTEM.LIVE_FEATURE_FLAGS)),
  LIVE_FLAGS_INPROC_TTL_MS
);

export async function getLiveFeatureFlags() {
  let cached: string | null;
  try {
    // Wall-clock deadline so a silent sysRedis half-open can't park this read
    // (evaluated on the generation/feature-flag hot path) ~11min.
    cached = await getLiveFeatureFlagsRawMemo();
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getLiveFeatureFlags', err);
    return DEFAULT_LIVE_FEATURE_FLAGS;
  }
  if (cached) {
    const data = JSON.parse(cached) as LiveFeatureFlags;
    return data;
  }

  return DEFAULT_LIVE_FEATURE_FLAGS;
}
