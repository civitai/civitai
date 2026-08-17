import { z } from 'zod';
import {
  MAX_AWARD_AMOUNT,
  MAX_CAP,
  OVERRIDE_FIELDS,
  REWARD_CONFIG_CONFLICT,
} from '~/shared/constants/reward-config.constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { rewardConfigReadFailedCounter } from '~/server/prom/client';
import { throwConflictError } from '~/server/utils/errorHandling';
import { createTtlMemo } from '~/server/utils/ttl-memoize';
import { hashifyObject } from '~/utils/string-helpers';

export const REWARD_CONFIG_KEY = 'rewards:config';

// Re-exported so existing importers of this module keep working; the definitions
// live in a neutral module the panel can read without pulling in db clients.
export {
  MAX_AWARD_AMOUNT,
  MAX_CAP,
  OVERRIDE_FIELDS,
  REWARD_CONFIG_CONFLICT,
} from '~/shared/constants/reward-config.constants';

/**
 * The single definition of an operator override. `setRewardConfig` validates
 * writes with this same schema, so a typo dies at write time rather than
 * persisting as a row the read path quietly refuses.
 */
// 🔴 `.strict()`, not the zod default. A non-strict object STRIPS an unknown key,
// so `{"enable": false}` or `{"Enabled": false}` — a plausible hand-edit — would
// parse clean to `{}` and resolve to enabled, with nothing rejected and nothing
// logged. The operator's edit reads as applied and the reward keeps paying, which
// is the exact hole this feature exists to close, one level in.
export const rewardOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    awardAmount: z.number().int().min(0).max(MAX_AWARD_AMOUNT).optional(),
    cap: z.number().int().min(0).max(MAX_CAP).optional(),
  })
  .strict();

/**
 * The tRPC input shape. NOT strict at the envelope: a base-procedure middleware
 * adds `browsingLevel` to every input, and zod strips it here rather than
 * refusing the call. The router passes only `rewards` on to the write, so the
 * injected field cannot reach the row.
 */
export const rewardConfigSchema = z.object({
  rewards: z.record(z.string(), rewardOverrideSchema).optional(),
});

/**
 * What a STORED row must look like. Strict, because a row written without the
 * wrapper — `{"dailyBoost": {"enabled": false}}`, what someone hand-editing in
 * Retool writes — would otherwise parse as an envelope with no `rewards` key,
 * leave every reward on, and warn about nothing.
 */
export const storedRewardConfigSchema = rewardConfigSchema.strict();

/** The write input: the row, plus the two guards. */
export const setRewardConfigSchema = rewardConfigSchema.extend({
  /** The `hash` from `getStoredRewardConfig`. Omit for an unconditional write. */
  expectedHash: z.string().optional(),
  /** Save over a row that cannot be parsed, and therefore could not be shown. */
  force: z.boolean().optional(),
});

export type RewardOverride = z.infer<typeof rewardOverrideSchema>;
/** The honoured override plus the names of the fields that were refused. */
export type RewardConfigEntry = { override: RewardOverride; rejected: string[] };
export type RewardConfig = Record<string, RewardConfigEntry>;

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
  let recognised = 0;

  for (const field of OVERRIDE_FIELDS) {
    if (!(field in record)) continue;
    recognised++;

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

  const unknown = Object.keys(record).filter(
    (key) => !(OVERRIDE_FIELDS as readonly string[]).includes(key)
  );
  rejected.push(...unknown);

  // An entry made ENTIRELY of keys we do not recognise is an instruction we
  // cannot carry out — `{"enable": false}`, `{"disabled": true}` — so it disables
  // rather than resolving to on. An entry that also sets a real field keeps that
  // field and only reports the stray key: `{"cap": 8, "note": "launch"}` should
  // not take a reward down.
  if (recognised === 0 && unknown.length) override.enabled = false;

  warn('Rejected reward override fields', { rewardType: type, rejected, stored: record });
  return { override, rejected };
}

function buildConfig(rewards: Record<string, unknown>): RewardConfig {
  const config: RewardConfig = {};
  for (const [type, value] of Object.entries(rewards)) config[type] = usableOverride(type, value);
  return config;
}

// Strict, so a row missing the `rewards` wrapper is a parse failure that warns
// rather than an envelope with no rewards in it that silently leaves every reward
// enabled. The entries themselves stay `unknown` here — `usableOverride` salvages
// them field by field, which the strict override schema would not.
// NOT strict, and that is the fix rather than an oversight — see `loadConfig`.
const envelopeSchema = z.object({ rewards: z.record(z.string(), z.unknown()).optional() });

async function loadConfig(): Promise<RewardConfig> {
  const row = await dbRead.keyValue.findUnique({ where: { key: REWARD_CONFIG_KEY } });
  const stored = row?.value ?? {};
  const envelope = envelopeSchema.safeParse(stored);

  if (!envelope.success) {
    // Not an object at all. Nothing here says which rewards were meant, so this
    // is the one case with no better answer than running unconfigured.
    warn('Ignoring malformed reward config row — every reward is running unconfigured', {
      stored,
    });
    return {};
  }

  // 🔴 A stray TOP-LEVEL key must not discard a perfectly good `rewards` map.
  //
  // A strict envelope here threw the whole row away over one unrecognised key —
  // `{"rewards": {…}, "note": "for the launch"}` — and every reward an operator
  // had turned off resumed paying. That is the same situation `usableOverride`
  // already handles one level down, where the rule is "a stray key beside a real
  // field keeps the real field", and it must fail the same way at both levels:
  // the difference here is only that the blast radius is every reward at once,
  // and the direction is paying rather than not paying.
  const strays = Object.keys(stored as MixedObject).filter((key) => key !== 'rewards');

  if (strays.length)
    warn(
      envelope.data.rewards === undefined
        ? 'Reward config row has no `rewards` wrapper — every reward is running unconfigured'
        : 'Ignoring unrecognised top-level keys in the reward config row',
      { strays, stored }
    );

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
  /** Identifies this version of the row for the concurrency check on write. */
  hash: string;
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
 * `hash` identifies the row the caller saw. Hand it back to `setRewardConfig`
 * and a write that would clobber someone else's edit is refused instead.
 *
 * ⚠️ The value is UNPARSED, so a hand-written row can carry a `__proto__` own
 * key through to the caller. Harmless to render; not harmless to spread or
 * deep-merge. (The parsed paths drop it rather than assigning it.)
 */
export async function getStoredRewardConfig(): Promise<StoredRewardConfig> {
  // 🔴 The PRIMARY, not `dbRead`. This hash is a version token, and a replica
  // serves it from before another moderator's write: the second moderator loads
  // a stale row with a matching stale hash, edits for as long as they like, and
  // the guard passes on save because both sides came from the same stale read.
  // No concurrency window is required — only that the LOAD fell inside one.
  const row = await dbWrite.keyValue.findUnique({ where: { key: REWARD_CONFIG_KEY } });
  const value = row?.value ?? {};
  return {
    value,
    malformed: !storedRewardConfigSchema.safeParse(value).success,
    hash: rewardConfigHash(value),
  };
}

/**
 * Identifies a stored row for the concurrency check. Both callers normalise an
 * absent row to `{}` before hashing, so there is no nullish case to handle here
 * — `hashifyObject` would return '' for one, and a guard for it would be
 * unreachable code that reads as though it were load-bearing.
 */
function rewardConfigHash(value: unknown) {
  return String(hashifyObject(value));
}

/**
 * Write-time validation is where an operator typo should die. The read path
 * salvages what it can from a bad row because it must keep paying rewards; this
 * refuses the whole write instead, so the row on disk is always one the read
 * path will honour in full.
 *
 * Only invalidates the caller's own cache — other pods pick the change up within
 * `CONFIG_TTL_MS`.
 *
 * 🔴 This REPLACES the row. A caller sending only the rewards it changed erases
 * every other reward's override, so the panel always submits the whole map.
 *
 * Two guards, because they fail differently and neither covers the other:
 *
 * - `expectedHash` is the ordinary case. A panel makes two moderators on the same
 *   screen normal rather than theoretical, and last-write-wins between them is
 *   silent. Omit it and the write is unconditional, which is what a script wants.
 * - `force` is the pathological one. A row that does not parse cannot be shown
 *   faithfully in an editor, so overwriting it blind would discard whatever the
 *   operator could not see. Refused unless someone says explicitly to do it.
 */
export async function setRewardConfig(
  config: z.infer<typeof rewardConfigSchema>,
  userId: number,
  { expectedHash, force = false }: { expectedHash?: string; force?: boolean } = {}
) {
  const value = storedRewardConfigSchema.parse(config);

  // The primary, for the reason given on `getStoredRewardConfig`: a guard that
  // reads a replica passes on a stale row, and this one decides whether another
  // moderator's write survives.
  const row = await dbWrite.keyValue.findUnique({ where: { key: REWARD_CONFIG_KEY } });
  // Normalised exactly as the reader normalises it. Gating the malformed check on
  // the RAW value instead makes a row present as JSON `null` report readable to
  // the panel — clean form, no force button — while refusing every save it makes,
  // with the only control that could pass `force` not rendered.
  const previous = row?.value ?? {};

  // Ordered so an unreadable row is reported as unreadable even when the hash is
  // ALSO stale. Both are true at once for anyone who loaded before someone else
  // broke the row, and only one of the two messages names an action that works:
  // reloading an unreadable row gets you the same unreadable row.
  if (!force && !storedRewardConfigSchema.safeParse(previous).success)
    throw throwConflictError(REWARD_CONFIG_CONFLICT.unreadable);

  if (expectedHash !== undefined && expectedHash !== rewardConfigHash(previous))
    throw throwConflictError(REWARD_CONFIG_CONFLICT.stale);

  await dbWrite.keyValue.upsert({
    where: { key: REWARD_CONFIG_KEY },
    create: { key: REWARD_CONFIG_KEY, value },
    update: { value },
  });

  // A money-affecting change with no attribution is not auditable, and this one
  // is reachable by any moderator. Axiom rather than `ctx.track`, because a new
  // ClickHouse action outside the enum is dropped silently, and rather than
  // `ModActivity`, whose unique key makes it a happened-once table.
  logToAxiom({
    name: 'reward-config',
    type: 'info',
    message: 'Reward config updated',
    userId,
    previous: JSON.stringify(previous ?? null),
    value: JSON.stringify(value),
  }).catch(() => null);

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
