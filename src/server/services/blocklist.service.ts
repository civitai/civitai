import { CacheTTL } from '~/server/common/constants';
import { BlocklistType } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type {
  RemoveBlocklistItemSchema,
  UpsertBlocklistSchema,
} from '~/server/schema/blocklist.schema';
import { throwNotFoundError } from '~/server/utils/errorHandling';

export type BlocklistDTO = {
  id?: number;
  type: string;
  data: string[];
};

const blocklists = new Map<string, BlocklistDTO>();

function getBlocklistKey(type: string) {
  return `${REDIS_KEYS.SYSTEM.BLOCKLIST}:${type}` as RedisKeyTemplateCache;
}

async function setCache({ type, data }: { type: string; data: BlocklistDTO }) {
  await redis.set(`${REDIS_KEYS.SYSTEM.BLOCKLIST}:${type}`, JSON.stringify(data), {
    EX: CacheTTL.month,
  });
  blocklists.set(type, data);
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
  const mapped = blocklists.get(type);
  if (mapped) return mapped;

  const key = getBlocklistKey(type);
  const cached = await redis.get(key);
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
      const url = new URL(match);
      if (blockedDomains.some((x) => x === url.host)) blockedFor.push(match);
    }
  }

  if (blockedFor.length) throw new Error(`invalid urls: ${blockedFor.join(', ')}`);
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
