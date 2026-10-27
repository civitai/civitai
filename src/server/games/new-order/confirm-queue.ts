export const CONFIRM_QUEUE_DEFAULTS = { poolCap: 2000, ttlDays: 14 };

export const MAX_POOL_ATTEMPTS = 5;

export type ConfirmQueueConfig = typeof CONFIRM_QUEUE_DEFAULTS;

export type AgreedItem = {
  id: number;
  imageId: number;
  url: string;
  firstLevel: number;
  imageLevel: number;
  firstModId: number;
  secondModId: number;
  firstSetAt: Date;
  secondAt: Date;
};

export type PooledItem = { id: number; imageId: number; secondAt: Date };

export type ConfirmStore = {
  agreedUnpooled(): Promise<AgreedItem[]>;
  /** Records both judgments and the pooling together; false when the labels could not be recorded. */
  markPooled(item: AgreedItem, now: Date): Promise<boolean>;
  /** Counts a failed pooling attempt; an item stops being offered after MAX_POOL_ATTEMPTS. */
  markPoolFailed(ids: number[]): Promise<void>;
  markStale(ids: number[], now: Date): Promise<void>;
  pooledActive(): Promise<PooledItem[]>;
  markExpired(ids: number[], now: Date): Promise<void>;
};

export type ConfirmPools = {
  add(imageIds: number[]): Promise<void>;
  remove(imageIds: number[]): Promise<void>;
};

const DAY_MS = 86_400_000;

export function planRotation({
  items,
  now,
  ttlDays,
  cap,
}: {
  items: { id: number; secondAt: Date }[];
  now: Date;
  ttlDays: number;
  cap: number;
}): number[] {
  const cutoff = now.getTime() - ttlDays * DAY_MS;
  const expired = items.filter((i) => i.secondAt.getTime() < cutoff);
  const live = items
    .filter((i) => i.secondAt.getTime() >= cutoff)
    .sort((a, b) => b.secondAt.getTime() - a.secondAt.getTime());
  return [...expired, ...live.slice(cap)].map((i) => i.id);
}

export async function runConfirmSync({
  store,
  pools,
  now = new Date(),
  config = CONFIRM_QUEUE_DEFAULTS,
}: {
  store: ConfirmStore;
  pools: ConfirmPools;
  now?: Date;
  config?: ConfirmQueueConfig;
}) {
  const result = { pooled: 0, stale: 0, failed: 0, expired: 0 };

  const items = await store.agreedUnpooled();
  const current = items.filter((i) => i.imageLevel === i.firstLevel);
  const stale = items.filter((i) => i.imageLevel !== i.firstLevel);
  if (stale.length) {
    await store.markStale(
      stale.map((i) => i.id),
      now
    );
    result.stale = stale.length;
  }

  const failedItems: AgreedItem[] = [];
  if (current.length) {
    await pools.add(current.map((i) => i.imageId));
    for (const item of current) {
      if (await store.markPooled(item, now)) result.pooled++;
      else failedItems.push(item);
    }
    result.failed = failedItems.length;
    if (failedItems.length) {
      await store.markPoolFailed(failedItems.map((i) => i.id));
    }
  }

  const active = await store.pooledActive();
  const expireIds = new Set(
    planRotation({ items: active, now, ttlDays: config.ttlDays, cap: config.poolCap })
  );
  const expiring = active.filter((i) => expireIds.has(i.id));
  const stillPooled = new Set(active.filter((i) => !expireIds.has(i.id)).map((i) => i.imageId));
  const removeImageIds = [...new Set([...expiring, ...failedItems].map((i) => i.imageId))].filter(
    (imageId) => !stillPooled.has(imageId)
  );
  if (removeImageIds.length) await pools.remove(removeImageIds);
  if (expiring.length) {
    await store.markExpired(
      expiring.map((i) => i.id),
      now
    );
    result.expired = expiring.length;
  }
  return result;
}
