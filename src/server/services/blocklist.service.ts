import { CacheTTL } from '~/server/common/constants';
import { BlocklistType } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type {
  RemoveBlocklistItemSchema,
  UpsertBlocklistSchema,
} from '~/server/schema/blocklist.schema';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { createLruCache } from '~/server/utils/lru-cache';
import { logToAxiom } from '~/server/logging/client';
import { buildBenignPhraseRegex } from '~/shared/utils/benign-phrases';

export type BlocklistDTO = {
  id?: number;
  type: string;
  data: string[];
};

function getBlocklistKey(type: string) {
  return `${REDIS_KEYS.SYSTEM.BLOCKLIST}:${type}` as RedisKeyTemplateCache;
}

// No in-process cache: pod-local copies can't be invalidated cross-pod on upsert.
async function setCache({ type, data }: { type: string; data: BlocklistDTO }) {
  await redis.set(getBlocklistKey(type), JSON.stringify(data), {
    EX: CacheTTL.month,
  });
}

export async function upsertBlocklist({ id, type, blocklist }: UpsertBlocklistSchema) {
  const existingBlocklistData = !id
    ? []
    : await dbWrite.blocklist
        .findUnique({ where: { id }, select: { data: true } })
        .then((result) => result?.data ?? []);

  const blocklistData = blocklist.map((item) => item.toLowerCase()).filter((x) => x.length > 0);

  const result = !id
    ? await dbWrite.blocklist.create({
        data: { data: blocklistData, type },
        select: { id: true, type: true, data: true },
      })
    : await dbWrite.blocklist.update({
        where: { id },
        data: { data: [...new Set([...existingBlocklistData, ...blocklistData])] },
        select: { id: true, type: true, data: true },
      });
  if (!result) throw new Error('failed to update blocklist');
  // Refresh from the deterministic read, not from `result`: caching the row just written
  // is what let an edit to a duplicate row silently promote it to the live one.
  await setCache({ type: result.type, data: await readBlocklistRow(result.type as BlocklistType) });
}

/**
 * Nothing stops a type having more than one row, and `EmailDomain` has two in production
 * — 8292 entries against 3, with the 3 present in neither the other row nor anything
 * else. The old read took `findFirst` with no `orderBy`, so which set was live was up to
 * Postgres; worse, `upsertBlocklist` wrote the row it had just touched into a cache key
 * scoped to the TYPE, so the last row a moderator edited won for a month regardless. The
 * loser's entries were simply not enforced, and the winner could change on an unrelated
 * edit.
 *
 * This picks the lowest id, always, and reports the duplicate. It deliberately does NOT
 * union the rows: for a deny-list a union blocks more, but for the benign lists a union
 * strips more, which is a moderation bypass — one helper cannot silently pick a safe
 * direction for both. Nor does it throw: this read gates account signup, so a duplicate
 * row would become an outage. Deterministic-and-loud is the compromise until the rows are
 * merged and a unique index on `type` makes it unrepresentable.
 */
async function readBlocklistRow(type: BlocklistType): Promise<BlocklistDTO> {
  const rows = await dbWrite.blocklist.findMany({
    where: { type },
    select: { id: true, type: true, data: true },
    orderBy: { id: 'asc' },
  });

  if (rows.length > 1) {
    logToAxiom({
      name: 'blocklist-duplicate-rows',
      type: 'error',
      message:
        'More than one Blocklist row for a type; entries on the ignored rows are not enforced',
      details: {
        blocklistType: type,
        usedId: rows[0].id,
        ignoredIds: rows.slice(1).map((row) => row.id),
        ignoredEntryCounts: rows.slice(1).map((row) => row.data.length),
      },
    }).catch(() => undefined);
  }

  return rows[0] ?? { type, data: [] };
}

export async function getBlocklistDTO({ type }: { type: BlocklistType }) {
  const cached = await redis.get(getBlocklistKey(type));
  if (cached) return JSON.parse(cached) as BlocklistDTO;

  const result = await readBlocklistRow(type);

  await setCache({ type: result.type, data: result });
  return result;
}

export async function getBlocklistData(type: BlocklistType) {
  return await getBlocklistDTO({ type }).then((blocklist) => blocklist.data);
}

export async function removeBlocklistItems({ id, items }: RemoveBlocklistItemSchema) {
  const result = await dbWrite.blocklist.findUnique({
    where: { id },
    select: { type: true, data: true },
  });
  if (!result) throw throwNotFoundError();
  const lowerCaseItems = items.map((x) => x.toLowerCase());

  const blocklist = result.data.filter((item) => !lowerCaseItems.includes(item));

  const updateResult = await dbWrite.blocklist.update({
    where: { id },
    data: { data: blocklist },
    select: { id: true, type: true, data: true },
  });

  await setCache({
    type: updateResult.type,
    data: await readBlocklistRow(updateResult.type as BlocklistType),
  });
}

// #region [blocked links]
export async function throwOnBlockedLinkDomain(value: string) {
  const blockedDomains = await getBlocklistData(BlocklistType.LinkDomain);
  const matches = value
    .toLowerCase()
    .match(
      /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])/gim
    );
  const blockedFor: string[] = [];
  if (matches) {
    for (const match of matches) {
      let url: URL;
      try {
        url = new URL(match);
      } catch {
        // A regex-matched substring that `new URL()` can't parse isn't a URL we
        // can attribute to a host, so it can't be a blocked-domain hit. Skip it
        // (rather than block) — and, critically, never let a raw TypeError escape
        // as a 500 on user input. This IS reachable: e.g. `http://1.1.1.256/x`
        // matches the link regex but `new URL()` rejects the invalid IPv4 octet.
        continue;
      }
      if (blockedDomains.some((x) => x === url.host)) blockedFor.push(match);
    }
  }

  // User-input validation rejection → BAD_REQUEST (400), not a plain Error (which
  // the tRPC layer would wrap as INTERNAL_SERVER_ERROR / 500).
  if (blockedFor.length) throwBadRequestError(`invalid urls: ${blockedFor.join(', ')}`);
}
// #endregion

// #region [benign phrases]
// In-process TTL cache over the Redis-backed blocklist: the scan path strips benign
// phrases on every image, so a short-lived local copy avoids a Redis round-trip per
// scan. TTL (not cross-pod invalidation) is the freshness bound — a moderator edit
// takes effect within `ttl` on every pod, which is fine for this non-urgent list.
const benignPhraseRegexCache = createLruCache<BlocklistType, { pattern: RegExp | null }>({
  name: 'benign-phrase-regex',
  ttl: CacheTTL.xs * 1000,
  keyFn: (type) => type,
  fetchFn: async (type) => ({ pattern: buildBenignPhraseRegex(await getBlocklistData(type)) }),
});

export { buildBenignPhraseRegex };

export async function stripBenignPhrases(text = '', type: BlocklistType) {
  if (!text) return text;
  const { pattern } = await benignPhraseRegexCache.fetch(type);
  if (!pattern) return text;
  return text.replace(pattern, ' ');
}
/**
 * The benign lists the BROWSER needs. The search gates (`AutocompleteSearch`,
 * `SearchLayout`) run their POI / minor / profanity checks client-side against Meili
 * directly, so there is no server hop to strip on — the lists have to be shipped down.
 * Public and edge-cached; these are phrases moderators have declared SAFE, so the list
 * says nothing about what we block.
 */
export async function getClientBenignLists() {
  try {
    const [prompt, profanityWords] = await Promise.all([
      getBlocklistData(BlocklistType.PromptBenignPhrase),
      getBlocklistData(BlocklistType.ProfanityBenignWord),
    ]);
    return { prompt, profanityWords };
  } catch (error) {
    // Fails OPEN to empty lists, and empty is the safe direction here: no whitelist means
    // nothing is stripped, so the gates flag more rather than less. Unlike its neighbours in
    // `system-cache` this read has no deadline wrapper, so a Redis or DB stall would
    // otherwise reject into a 500 on an unauthenticated endpoint that every search box calls.
    logToAxiom({
      name: 'benign-lists-unavailable',
      type: 'warning',
      message: 'Serving empty benign lists to the client; search gates will not strip',
      details: { error: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined);
    return { prompt: [] as string[], profanityWords: [] as string[] };
  }
}
// #endregion

// #region [blocked message patterns]
export async function throwOnBlockedMessagePattern(value: string) {
  const blockedPatterns = await getBlocklistData(BlocklistType.MessagePattern);
  if (!blockedPatterns.length) return;

  const lowerValue = value.toLowerCase();
  const matched = blockedPatterns.find((pattern) => lowerValue.includes(pattern));
  if (matched) throw new Error(`Message blocked by content filter`);
}
// #endregion

// #region [blocked emails]
export async function getBlockedEmailDomains() {
  return await getBlocklistData(BlocklistType.EmailDomain);
}
// #endregion
