import { describe, it, expect } from 'vitest';
import { redisEnvSchema } from '../env';

// Minimal valid base — the two required URLs; everything else has a default.
const base = {
  REDIS_URL: 'redis://localhost:6379',
  REDIS_SYS_URL: 'redis://localhost:6380',
};

describe('redisEnvSchema — HA defaults', () => {
  it('applies the sysRedis HA / socket defaults', () => {
    const parsed = redisEnvSchema.parse(base);
    // Cache client gets the aggressive 504-cascade teardown; sys client disabled by default.
    expect(parsed.REDIS_SOCKET_TIMEOUT_MS).toBe(10000);
    expect(parsed.REDIS_SYS_SOCKET_TIMEOUT_MS).toBe(0);
    // Heap + recovery guards on the sys client.
    expect(parsed.REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH).toBe(10000);
    // Keepalive ping + cluster command backstop.
    expect(parsed.REDIS_PING_INTERVAL_MS).toBe(5000);
    expect(parsed.REDIS_CLUSTER_COMMAND_TIMEOUT_MS).toBe(15000);
    // Sentinel is opt-in.
    expect(parsed.REDIS_SYS_SENTINELS).toBeUndefined();
  });

  it('coerces numeric env strings', () => {
    const parsed = redisEnvSchema.parse({
      ...base,
      REDIS_SOCKET_TIMEOUT_MS: '8000',
      REDIS_PING_INTERVAL_MS: '3000',
    });
    expect(parsed.REDIS_SOCKET_TIMEOUT_MS).toBe(8000);
    expect(parsed.REDIS_PING_INTERVAL_MS).toBe(3000);
  });
});

describe('redisEnvSchema — sentinel superRefine', () => {
  it('rejects REDIS_SYS_SENTINELS without REDIS_SYS_SENTINEL_NAME', () => {
    const result = redisEnvSchema.safeParse({
      ...base,
      REDIS_SYS_SENTINELS: 'sentinel-a:26379,sentinel-b:26379',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('REDIS_SYS_SENTINEL_NAME'))).toBe(
        true
      );
    }
  });

  it('accepts sentinels WITH a name', () => {
    const result = redisEnvSchema.safeParse({
      ...base,
      REDIS_SYS_SENTINELS: 'sentinel-a:26379',
      REDIS_SYS_SENTINEL_NAME: 'sysmaster',
    });
    expect(result.success).toBe(true);
  });

  it('leaves the non-sentinel path (REDIS_SYS_URL only) unaffected', () => {
    expect(redisEnvSchema.safeParse(base).success).toBe(true);
  });
});
