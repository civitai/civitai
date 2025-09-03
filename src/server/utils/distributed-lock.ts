import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { handleLogError } from '~/server/utils/errorHandling';

export interface DistributedLockOptions {
  key: string;
  ttl?: number; // TTL in seconds, default 30
  retryDelay?: number; // Retry delay in ms, default 100
  maxRetries?: number; // Max retries, default 10
}

export class DistributedLock {
  private readonly lockKey: RedisKeyTemplateCache;
  private readonly ttl: number;
  private readonly retryDelay: number;
  private readonly maxRetries: number;
  private lockValue: string | null = null;

  constructor(options: DistributedLockOptions) {
    this.lockKey = `${REDIS_KEYS.CACHE_LOCKS}:${options.key}`;
    this.ttl = options.ttl ?? 30;
    this.retryDelay = options.retryDelay ?? 100;
    this.maxRetries = options.maxRetries ?? 10;
  }

  async acquire(): Promise<boolean> {
    if (!redis) return false; // Fallback when Redis is not available

    this.lockValue = `${Date.now()}-${Math.random()}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await redis.set(this.lockKey, this.lockValue, {
          PX: this.ttl * 1000,
          NX: true,
        });

        if (result === 'OK') {
          return true;
        }

        if (attempt < this.maxRetries) {
          await this.delay(this.retryDelay);
        }
      } catch (error) {
        handleLogError(error as Error, `Failed to acquire lock: ${this.lockKey}`);
        return false; // Fallback to prevent operation if Redis fails
      }
    }

    return false;
  }

  async release(): Promise<void> {
    if (!redis || !this.lockValue) return;

    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      await redis.eval(script, {
        keys: [this.lockKey],
        arguments: [this.lockValue],
      });
    } catch (error) {
      handleLogError(error as Error, `Failed to release lock: ${this.lockKey}`);
    } finally {
      this.lockValue = null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export async function withDistributedLock<T>(
  options: DistributedLockOptions,
  operation: () => Promise<T>
): Promise<T | null> {
  const lock = new DistributedLock(options);

  const acquired = await lock.acquire();
  if (!acquired) {
    return null; // Could not acquire lock
  }

  try {
    return await operation();
  } finally {
    await lock.release();
  }
}
