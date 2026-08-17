import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

export const REWARD_CONFIG_KEY = 'rewards:config';

// Live award amounts run 1..500 and caps 25..1500, so these leave room for a
// deliberate order-of-magnitude change while refusing the operator typo that
// adds a zero to the largest of them.
export const MAX_AWARD_AMOUNT = 5_000;
export const MAX_CAP = 100_000;

/**
 * The single definition of an operator override. The admin mutation validates
 * writes with this same schema, so what can be stored and what will be honoured
 * cannot drift apart.
 */
export const rewardOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  awardAmount: z.number().int().min(0).max(MAX_AWARD_AMOUNT).optional(),
  cap: z.number().int().min(0).max(MAX_CAP).optional(),
});

export const rewardConfigSchema = z.object({
  rewards: z.record(z.string(), rewardOverrideSchema).optional(),
});

export type RewardOverride = z.infer<typeof rewardOverrideSchema>;
/** The honoured override plus the names of the fields that were refused. */
export type RewardConfigEntry = { override: RewardOverride; rejected: string[] };
export type RewardConfig = Record<string, RewardConfigEntry>;

const OVERRIDE_FIELDS = ['enabled', 'awardAmount', 'cap'] as const;

export type RewardDefaults = {
  awardAmount: number;
  cap?: number;
  /**
   * False for a reward whose cap is a multi-entry table: one number cannot say
   * whether it means the daily or the monthly cap.
   */
  capOverridable: boolean;
};

export type ResolvedRewardConfig = {
  enabled: boolean;
  awardAmount: number;
  cap?: number;
  /** Fields an operator set that were refused, for the operator-facing view. */
  rejected: string[];
};

const CONFIG_TTL_MS = 60 * 1000;

type CacheEntry = { config: RewardConfig; expiresAt: number };

// Cache the parsed config, not the resolved decision: `resolveRewardConfig`
// still runs per call so a definition change or a differing default resolves
// against the current values rather than a snapshot.
let configCache: CacheEntry | null = null;
const warnedMultiCap = new Set<string>();

export function invalidateRewardConfigCache() {
  configCache = null;
  warnedMultiCap.clear();
}

const warn = (message: string, data: MixedObject) => {
  logToAxiom({ name: 'reward-config', type: 'warning', message, ...data }).catch();
};

/**
 * Keep the fields that parse rather than dropping the whole reward. An operator
 * typo in `cap` must not silently re-enable a reward they turned off in the
 * same edit.
 */
function usableOverride(type: string, value: unknown): RewardConfigEntry {
  const parsed = rewardOverrideSchema.safeParse(value);
  if (parsed.success) return { override: parsed.data, rejected: [] };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn('Ignoring malformed reward override', { rewardType: type, stored: value });
    return { override: {}, rejected: [...OVERRIDE_FIELDS] };
  }

  const record = value as MixedObject;
  const override: RewardOverride = {};
  const rejected: string[] = [];

  for (const field of OVERRIDE_FIELDS) {
    if (!(field in record)) continue;
    const result = rewardOverrideSchema.shape[field].safeParse(record[field]);
    if (result.success) Object.assign(override, { [field]: result.data });
    else rejected.push(field);
  }

  warn('Rejected reward override fields', { rewardType: type, rejected, stored: record });
  return { override, rejected };
}

async function loadConfig(): Promise<RewardConfig> {
  const row = await dbRead.keyValue.findUnique({ where: { key: REWARD_CONFIG_KEY } });
  const envelope = z
    .object({ rewards: z.record(z.string(), z.unknown()).optional() })
    .safeParse(row?.value ?? {});

  if (!envelope.success) {
    warn('Ignoring malformed reward config row', { stored: row?.value });
    return {};
  }

  const config: RewardConfig = {};
  for (const [type, value] of Object.entries(envelope.data.rewards ?? {}))
    config[type] = usableOverride(type, value);

  return config;
}

async function getRewardConfig(): Promise<RewardConfig> {
  const now = Date.now();
  if (configCache && configCache.expiresAt > now) return configCache.config;

  try {
    const config = await loadConfig();
    configCache = { config, expiresAt: now + CONFIG_TTL_MS };
    return config;
  } catch (error) {
    // No negative caching: a transient KeyValue failure must not pin every
    // reward to its compiled default for a full TTL.
    warn('Reward config read failed, using compiled defaults', {
      error: (error as Error)?.message,
    });
    return {};
  }
}

/**
 * Compiled values are the defaults; the stored row only ever narrows or moves
 * them. Nothing here can fall back to zero, and nothing here throws — a reward
 * grant must not depend on the config read succeeding.
 */
export async function resolveRewardConfig(
  type: string,
  defaults: RewardDefaults
): Promise<ResolvedRewardConfig> {
  const entry = (await getRewardConfig())[type];
  const override = entry?.override ?? {};
  const rejected = [...(entry?.rejected ?? [])];

  let cap = defaults.cap;
  if (override.cap !== undefined) {
    if (defaults.capOverridable) cap = override.cap;
    else {
      rejected.push('cap');
      if (!warnedMultiCap.has(type)) {
        warnedMultiCap.add(type);
        warn('Refusing cap override for a reward with a multi-entry cap table', {
          rewardType: type,
          cap: override.cap,
        });
      }
    }
  }

  return {
    enabled: override.enabled ?? true,
    awardAmount: override.awardAmount ?? defaults.awardAmount,
    cap,
    rejected,
  };
}
