import { describe, it, expect, vi, afterEach } from 'vitest';
import { redisEnvSchema } from '../env';

// Minimal valid base — the two required URLs; everything else has a default.
const base = {
  REDIS_URL: 'redis://localhost:6379',
  REDIS_SYS_URL: 'redis://localhost:6380',
};

describe('redisEnvSchema — REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED', () => {
  it('defaults ON; only the literal "false" turns it off', () => {
    expect(redisEnvSchema.parse(base).REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED).toBe(true);
    expect(
      redisEnvSchema.parse({ ...base, REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED: 'false' })
        .REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED
    ).toBe(false);
    expect(
      redisEnvSchema.parse({ ...base, REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED: 'true' })
        .REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED
    ).toBe(true);
  });
});

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
    // Self-heal slow-settle threshold: 10s, deliberately BELOW the 15s reaper (invariant enforced
    // in the superRefine) so it catches the invisible 10–15s under-reaper band.
    expect(parsed.REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS).toBe(10000);
    expect(parsed.REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS).toBeLessThan(
      parsed.REDIS_CLUSTER_COMMAND_TIMEOUT_MS
    );
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

describe('redisEnvSchema — sys self-heal defaults', () => {
  it('applies the sys (sentinel) self-heal defaults', () => {
    const parsed = redisEnvSchema.parse(base);
    // ON by default (a forced reconnect is the only thing that clears the inflight-leak wedge).
    expect(parsed.REDIS_SYS_SELFHEAL_ENABLED).toBe(true);
    // Healthy sys inflight is single-digit; the incident wedge was 7k+.
    expect(parsed.REDIS_SYS_SELFHEAL_INFLIGHT_THRESHOLD).toBe(500);
    expect(parsed.REDIS_SYS_SELFHEAL_SUSTAINED_MS).toBe(20000);
    expect(parsed.REDIS_SYS_SELFHEAL_COOLDOWN_MS).toBe(60000);
    expect(parsed.REDIS_SYS_SELFHEAL_CHECK_INTERVAL_MS).toBe(1000);
    // Sys jitter is 4s; the cluster jitter was widened to 3s (2026-07-06) — the settle-time trigger
    // fires on a broader (>=10s) envelope, so more pods can trip together and need de-correlating.
    expect(parsed.REDIS_SYS_SELFHEAL_RECONNECT_JITTER_MS).toBe(4000);
    expect(parsed.REDIS_CLUSTER_SELFHEAL_RECONNECT_JITTER_MS).toBe(3000);
  });

  it('REDIS_SYS_SELFHEAL_ENABLED=false disables it (single-flip revert)', () => {
    const parsed = redisEnvSchema.parse({ ...base, REDIS_SYS_SELFHEAL_ENABLED: 'false' });
    expect(parsed.REDIS_SYS_SELFHEAL_ENABLED).toBe(false);
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

describe('redisEnvSchema — slow-settle < reaper invariant', () => {
  it('REJECTS a slow-settle threshold >= the command deadline (fix-defeating misconfig)', () => {
    // Operator lowers the reaper below the slow threshold: reaped orphans then settle at ~8s < 10s
    // → no hit recorded → self-heal blind. Must fail fast at startup.
    const result = redisEnvSchema.safeParse({
      ...base,
      REDIS_CLUSTER_COMMAND_TIMEOUT_MS: '8000',
      REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS: '10000',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes('REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS'))
      ).toBe(true);
    }
  });

  it('REJECTS slow-settle == reaper (must be strictly below)', () => {
    const result = redisEnvSchema.safeParse({
      ...base,
      REDIS_CLUSTER_COMMAND_TIMEOUT_MS: '10000',
      REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS: '10000',
    });
    expect(result.success).toBe(false);
  });

  it('ACCEPTS the defaults (10s slow < 15s reaper)', () => {
    expect(redisEnvSchema.safeParse(base).success).toBe(true);
  });

  it('does NOT enforce when the reaper is disabled (T=0): settle-time signal works without it', () => {
    const result = redisEnvSchema.safeParse({
      ...base,
      REDIS_CLUSTER_COMMAND_TIMEOUT_MS: '0',
      REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS: '10000',
    });
    expect(result.success).toBe(true);
  });

  it('does NOT enforce when slow-settle recording is disabled (S=0)', () => {
    const result = redisEnvSchema.safeParse({
      ...base,
      REDIS_CLUSTER_COMMAND_TIMEOUT_MS: '15000',
      REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS: '0',
    });
    expect(result.success).toBe(true);
  });
});

describe('redisEnvSchema — sys self-heal invariants', () => {
  const issuePaths = (env: Record<string, string>) => {
    const r = redisEnvSchema.safeParse({ ...base, ...env });
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };

  it('defaults: 30s sys command backstop, above the 20s sustained window', () => {
    const parsed = redisEnvSchema.parse(base);
    expect(parsed.REDIS_SYS_COMMAND_TIMEOUT_MS).toBe(30000);
    expect(parsed.REDIS_SYS_COMMAND_TIMEOUT_MS).toBeGreaterThan(
      parsed.REDIS_SYS_SELFHEAL_SUSTAINED_MS
    );
  });

  it('REJECTS a sys backstop at or under the sustained window (it would blind the watchdog)', () => {
    expect(issuePaths({ REDIS_SYS_COMMAND_TIMEOUT_MS: '20000' })).toEqual([
      'REDIS_SYS_COMMAND_TIMEOUT_MS',
    ]);
    expect(
      issuePaths({ REDIS_SYS_COMMAND_TIMEOUT_MS: '9000', REDIS_SYS_SELFHEAL_SUSTAINED_MS: '15000' })
    ).toEqual(['REDIS_SYS_COMMAND_TIMEOUT_MS']);
    expect(issuePaths({ REDIS_SYS_COMMAND_TIMEOUT_MS: '20001' })).toEqual([]);
  });

  it('REJECTS an in-flight cap at or under the inflight threshold', () => {
    expect(issuePaths({ REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH: '500' })).toEqual([
      'REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH',
    ]);
    expect(issuePaths({ REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH: '501' })).toEqual([]);
  });

  it('REDIS_SYS_COMMAND_TIMEOUT_MS=0 parses to 0 (the off switch) with the sys watchdog on', () => {
    const parsed = redisEnvSchema.parse({ ...base, REDIS_SYS_COMMAND_TIMEOUT_MS: '0' });
    expect(parsed.REDIS_SYS_COMMAND_TIMEOUT_MS).toBe(0);
    expect(parsed.REDIS_SYS_SELFHEAL_ENABLED).toBe(true);
  });

  it('does NOT enforce either when disabled (0) or when the sys watchdog is off', () => {
    expect(
      issuePaths({ REDIS_SYS_COMMAND_TIMEOUT_MS: '0', REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH: '0' })
    ).toEqual([]);
    expect(
      issuePaths({
        REDIS_SYS_SELFHEAL_ENABLED: 'false',
        REDIS_SYS_COMMAND_TIMEOUT_MS: '1000',
        REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH: '10',
      })
    ).toEqual([]);
  });
});

describe('loadRedisEnv — sys self-heal timeout-rate trigger mapping', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('maps THRESHOLD and WINDOW_MS onto their own config fields (a swap would silently disable the trigger)', async () => {
    vi.stubEnv('REDIS_URL', base.REDIS_URL);
    vi.stubEnv('REDIS_SYS_URL', base.REDIS_SYS_URL);
    // Values distinct from each other, from the defaults and from every other sys self-heal knob.
    vi.stubEnv('REDIS_SYS_SELFHEAL_TIMEOUT_THRESHOLD', '7');
    vi.stubEnv('REDIS_SYS_SELFHEAL_TIMEOUT_WINDOW_MS', '45000');
    vi.resetModules();
    const { loadRedisEnv } = await import('../env');
    const cfg = loadRedisEnv();
    expect(cfg.sysSelfHealTimeoutThreshold).toBe(7);
    expect(cfg.sysSelfHealTimeoutWindowMs).toBe(45000);
  });
});
