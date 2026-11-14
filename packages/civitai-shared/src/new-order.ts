/** The `nsfwLevelReason` the main app records on an image locked by a Knights consensus; any other reason on a lock is a moderator's. */
export const KNIGHTS_VOTE_NSFW_LEVEL_REASON = 'Knights Vote';

export const KNIGHTS_NSFW_LEVEL_QUESTION = 'knights.image.nsfwLevel';

/** Why an item went to the Inquisitors. Write-back handovers have none; they use `reason`. */
export const KNIGHTS_ESCALATION_REASONS = ['blocked', 'pushed-down', 'no-consensus'] as const;
export type KnightsEscalationReason = (typeof KNIGHTS_ESCALATION_REASONS)[number];

/** Why a settled rating could not be written to the image and went to the Inquisitors instead (`reason`). */
export const KNIGHTS_WRITEBACK_REASONS = [
  'blocked',
  'level-moved',
  'moderator-locked',
  'attempts-exhausted',
] as const;
export type KnightsWritebackReason = (typeof KNIGHTS_WRITEBACK_REASONS)[number];

/** Ranks a queue item can wait at. Acolytes cannot judge and Inquisitors are the end of the path. */
export const KNIGHTS_STAGE_RANKS = ['Knight', 'Templar', 'Paladin'] as const;

export const KNIGHTS_STAGE_TTL_HOURS = 72;

/** Why a Knight blocks an image: the original game's `NewOrderDamnedReason` names and labels, in its order. */
export const KNIGHTS_BLOCK_REASONS = [
  { value: 'InappropriateMinors', label: 'Inappropriate Minors' },
  { value: 'RealisticMinors', label: 'Realistic Minors' },
  { value: 'DepictsRealPerson', label: 'Depicts Real Person' },
  { value: 'Bestiality', label: 'Bestiality' },
  { value: 'Other', label: 'Other' },
] as const;

/**
 * The Knights v2 image sources switch, stored as JSON under `system:knights-v2-sources` in sysRedis.
 * The main app reads it to decide what to enqueue and the moderator app writes it, so the shape and the
 * reader live here: a field added on one side cannot drift from the other.
 */
export type KnightsSourcesConfig = {
  enabled: boolean;
  sfwRate: number;
  nsfwRate: number;
  /** Scan sampling pauses while more than this many Knight-stage items are open. Absent when not stored: read it with `knightsSourcesMaxOpen`. */
  maxOpen?: number;
};

/** The rates used when the stored JSON omits one. Reading never turns a missing key on. */
export const KNIGHTS_SOURCES_DEFAULT_RATES = { sfwRate: 1, nsfwRate: 0.3 } as const;

export const KNIGHTS_SOURCES_DEFAULT_MAX_OPEN = 5000;

export const knightsSourcesMaxOpen = (config: KnightsSourcesConfig): number =>
  config.maxOpen ?? KNIGHTS_SOURCES_DEFAULT_MAX_OPEN;

const KNIGHTS_SOURCES_OFF: KnightsSourcesConfig = {
  enabled: false,
  ...KNIGHTS_SOURCES_DEFAULT_RATES,
};

const clampRate = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

const readCap = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;

/** `stored` is false for an absent or unreadable value, which reads as off. */
export function readKnightsSourcesConfig(raw: string | Buffer | null): {
  config: KnightsSourcesConfig;
  stored: boolean;
} {
  const off = { config: KNIGHTS_SOURCES_OFF, stored: false };
  if (raw == null) return off;
  try {
    const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return off;
    const config = parsed as Record<string, unknown>;
    const maxOpen = readCap(config.maxOpen);
    return {
      stored: true,
      config: {
        enabled: config.enabled === true,
        sfwRate: clampRate(config.sfwRate, KNIGHTS_SOURCES_DEFAULT_RATES.sfwRate),
        nsfwRate: clampRate(config.nsfwRate, KNIGHTS_SOURCES_DEFAULT_RATES.nsfwRate),
        // Left out when not stored, so the moderator page's three-field shape reads back unchanged.
        ...(maxOpen === undefined ? {} : { maxOpen }),
      },
    };
  } catch {
    return off;
  }
}

export function parseKnightsSourcesConfig(raw: string | Buffer | null): KnightsSourcesConfig {
  return readKnightsSourcesConfig(raw).config;
}
