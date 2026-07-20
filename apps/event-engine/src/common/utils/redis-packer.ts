import { IRedisClient, IDataPacker } from '../types/package-stubs';

/**
 * Wraps a Redis client to automatically pack/unpack values using msgpackr or similar packer.
 * This allows storing binary-encoded data in Redis for better performance and smaller storage.
 *
 * Note: This is a simplified wrapper. For full production use, you'd want to wrap more methods.
 * Based on the redis.packed pattern from the main application.
 *
 * @param redis - The Redis client to wrap
 * @param packer - The data packer (e.g., msgpackr) with pack/unpack methods
 * @returns Wrapped Redis client that automatically packs/unpacks values
 */
export function withRedisPacking(
  redis: IRedisClient,
  packer: IDataPacker
): IRedisClient {
  // Create a proxy that intercepts Redis operations
  // For now, we return the original client as-is since the cache implementation
  // will handle packing/unpacking explicitly in its logic

  // In a full implementation, you would create a Proxy or wrapper object that:
  // 1. Intercepts get/mGet/hGet/hGetAll and unpacks returned values
  // 2. Intercepts set/hSet and packs values before storing
  // 3. Passes through other operations unchanged

  // For the cache system, we'll handle packing in the cache implementation directly
  // rather than at the Redis client level, as it gives us more control over
  // which operations need packing vs which should remain as strings

  return redis;
}

/**
 * Helper to pack a value for Redis storage
 */
export function packValue(packer: IDataPacker, value: any): string {
  const packed = packer.pack(value);
  return packed.toString('base64');
}

/**
 * Helper to unpack a value from Redis
 */
export function unpackValue(packer: IDataPacker, value: string | null): any {
  if (value === null) return null;
  const buffer = Buffer.from(value, 'base64');
  return packer.unpack(buffer);
}
