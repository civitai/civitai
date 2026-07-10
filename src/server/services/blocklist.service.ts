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
  await setCache({ type: result.type, data: result });
}

export async function getBlocklistDTO({ type }: { type: BlocklistType }) {
  const cached = await redis.get(getBlocklistKey(type));
  if (cached) return JSON.parse(cached) as BlocklistDTO;

  const result = await dbWrite.blocklist
    .findFirst({
      where: { type },
      select: { id: true, type: true, data: true },
    })
    .then((result): BlocklistDTO => (result ? result : { type, data: [] }));

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

  await setCache({ type: updateResult.type, data: updateResult });
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
const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compile a moderator-managed phrase list into a single whole-word, case-insensitive
// matcher. Whitespace in a phrase is loosened to `[^a-zA-Z0-9]+` (the same inter-word
// separator audit.ts uses) so "teen titans" also matches "teen  titans" / "teen-titans"
// / "teen.titans". Zero-width alnum boundaries (again matching audit.ts) instead of `\b`
// so a phrase whose edge is punctuation still anchors. Returns null for an empty list so
// callers can skip the replace.
export function buildBenignPhraseRegex(phrases: string[]): RegExp | null {
  const cleaned = phrases.map((p) => p.trim()).filter((p) => p.length > 0);
  if (!cleaned.length) return null;
  const alternation = cleaned.map((p) => escapeRegex(p).replace(/\s+/g, '[^a-zA-Z0-9]+')).join('|');
  return new RegExp(`(?<![a-zA-Z0-9])(?:${alternation})(?![a-zA-Z0-9])`, 'gi');
}

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

export async function stripBenignPhrases(text: string | undefined, type: BlocklistType) {
  if (!text) return text;
  const { pattern } = await benignPhraseRegexCache.fetch(type);
  if (!pattern) return text;
  return text.replace(pattern, ' ');
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
