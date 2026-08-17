import { z } from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { rewardConfigReadFailedCounter } from '~/server/prom/client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

export const REWARD_CONFIG_KEY = 'rewards:config';

// Live award amounts run 1..500 and caps 25..1500, so these leave room for a
// deliberate order-of-magnitude change while refusing the operator typo that
// adds a zero to the largest of them.
export const MAX_AWARD_AMOUNT = 5_000;
export const MAX_CAP = 100_000;

/**
 * The single definition of an operator override. `setRewardConfig` validates
 * writes with this same schema, so a typo dies at write time rather than
 * persisting as a row the read path quietly refuses.
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

export const CONFIG_TTL_MS = 60 * 1000;

const warnedMultiCap = new Set<string>();

// The last config we successfully read, kept as the fallback for a failed read.
// Falling back to the COMPILED defaults instead would fail open: the default for
// `enabled` is on, so a transient KeyValue blip would resume paying every reward
// an operator had turned off, and `process` would then pay out what `apply`
// wrote during the blip.
//
// ⚠️ This narrows the fail-open window, it does not close it. A pod that has
// never completed a successful read — a cold start during an outage — has no last
// good config and still falls back to compiled defaults, i.e. everything enabled.
// `reward_config_read_failed_total` is what makes that visible.
let lastGoodConfig: RewardConfig | null = null;

const warn = (message: string, data: MixedObject) => {
  logToAxiom({ name: 'reward-config', type: 'warning', message, ...data }).catch(() => null);
};

/**
 * `enabled` is the one field where falling back to the compiled default is the
 * wrong direction, because that default is ON. `"enabled": "false"` — what a
 * text field in Retool produces — would leave the reward paying while the
 * operator reads their edit back and believes it is off, with an Axiom warning
 * as the only signal.
 *
 * So accept the spellings an operator actually types, and treat anything else
 * PRESENT as off: a refused `enabled` stops the money and is loud. Absent still
 * means on.
 */
function coerceEnabled(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

/**
 * Keep the fields that parse rather than dropping the whole reward. An operator
 * typo in `cap` must not silently re-enable a reward they turned off in the
 * same edit.
 */
function usableOverride(type: string, value: unknown): RewardConfigEntry {
  const parsed = rewardOverrideSchema.safeParse(value);
  if (parsed.success) return { override: parsed.data, rejected: [] };

  // A whole entry that is not an object disables the reward, for the same reason
  // an unreadable `enabled` does — one level up. `{"dailyBoost": false}` is the
  // shorthand an operator reaches for when they want a reward off, and so are
  // `null` and `"disabled"`; resolving any of them to ON leaves the reward paying
  // against an edit that reads, to whoever made it, like it worked.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn('Malformed reward override, disabling the reward', { rewardType: type, stored: value });
    return { override: { enabled: false }, rejected: [...OVERRIDE_FIELDS] };
  }

  const record = value as MixedObject;
  const override: RewardOverride = {};
  const rejected: string[] = [];

  for (const field of OVERRIDE_FIELDS) {
    if (!(field in record)) continue;

    if (field === 'enabled') {
      const coerced = coerceEnabled(record.enabled);
      override.enabled = coerced ?? false;
      if (coerced === undefined) rejected.push('enabled');
      continue;
    }

    const result = rewardOverrideSchema.shape[field].safeParse(record[field]);
    if (result.success) Object.assign(override, { [field]: result.data });
    else rejected.push(field);
  }

  warn('Rejected reward override fields', { rewardType: type, rejected, stored: record });
  return { override, rejected };
}

function buildConfig(rewards: Record<string, unknown>): RewardConfig {
  const config: RewardConfig = {};
  for (const [type, value] of Object.entries(rewards)) config[type] = usableOverride(type, value);
  return config;
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

  return buildConfig(envelope.data.rewards ?? {});
}

// Cache the parsed config, not the resolved decision: `resolveRewardConfig`
// still runs per call so a definition change or a differing default resolves
// against the current values rather than a snapshot. `createTtlMemo` caches only
// a RESOLVED value, so a failed read is retried on the next call rather than
// pinning a fallback for a whole TTL.
// The clock is read per call rather than captured at module load, so a test can
// advance time instead of waiting out a real minute.
const configMemo = createTtlMemo(loadConfig, CONFIG_TTL_MS, () => Date.now());

export function invalidateRewardConfigCache() {
  configMemo.clear();
  warnedMultiCap.clear();
  lastGoodConfig = null;
}

async function getRewardConfig(): Promise<RewardConfig> {
  try {
    const config = await configMemo();
    lastGoodConfig = config;
    return config;
  } catch (error) {
    // Alertable, not just an Axiom line nobody watches: on this path every
    // disabled reward is running on a stale answer.
    rewardConfigReadFailedCounter?.inc?.();
    warn('Reward config read failed, using the last good config', {
      error: (error as Error)?.message,
      haveLastGood: !!lastGoodConfig,
    });
    return lastGoodConfig ?? {};
  }
}

export type StoredRewardConfig = {
  /** The row exactly as written. Not narrowed to the schema — see below. */
  value: unknown;
  /** True when the row would not survive `setRewardConfig`. */
  malformed: boolean;
};

/**
 * The stored row exactly as written, for an editor to render. Uncached, so an
 * operator fixing a refused field sees the row rather than a minute-old copy.
 *
 * 🔴 Returns the RAW value on a parse failure rather than an empty config.
 * `setRewardConfig` has replace semantics, and the row this feature exists to
 * fix — `enabled: "false"` from a Retool text field — is exactly the row that
 * fails the parse. Rendering `{}` for it would show an editor a lossless-looking
 * empty form whose first save wipes every other reward's override.
 *
 * ⚠️ Two moderators editing at once are last-write-wins; there is no version
 * guard on the row.
 */
export async function getStoredRewardConfig(): Promise<StoredRewardConfig> {
  const row = await dbRead.keyValue.findUnique({ where: { key: REWARD_CONFIG_KEY } });
  const value = row?.value ?? {};
  return { value, malformed: !rewardConfigSchema.safeParse(value).success };
}

/**
 * Write-time validation is where an operator typo should die. The read path
 * salvages what it can from a bad row because it must keep paying rewards; this
 * refuses the whole write instead, so the row on disk is always one the read
 * path will honour in full.
 *
 * Only invalidates the caller's own cache — other pods pick the change up within
 * `CONFIG_TTL_MS`.
 */
export async function setRewardConfig(config: z.infer<typeof rewardConfigSchema>) {
  const value = rewardConfigSchema.parse(config);

  await dbWrite.keyValue.upsert({
    where: { key: REWARD_CONFIG_KEY },
    create: { key: REWARD_CONFIG_KEY, value },
    update: { value },
  });

  invalidateRewardConfigCache();
  // Seed the fallback from what was just written. Clearing it and leaving it null
  // means a failed read on this pod moments later falls back to compiled defaults
  // — re-enabling the very reward this call just turned off.
  lastGoodConfig = buildConfig(value.rewards ?? {});
  return value;
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
