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
  /** Scan sampling pauses while more than this many Knight-stage rating items are open (yes/no questions do not count). Absent when not stored: read it with `knightsSourcesMaxOpen`. */
  maxOpen?: number;
  /** Share of yes/no questions Knights serves, 0 to 1 (0 turns them off). Absent when not stored: Knights then uses its environment default. */
  yesNoShare?: number;
  /** Knights game tuning saved on the moderator Config page. Absent when nothing is stored. */
  game?: KnightsGameSettings;
  ruleGuide?: KnightsRuleGuide;
};

/** A set is a title with notes, a bullet list (mild to severe), or both. */
export type KnightsRuleSet = { title: string; notes?: string; points: string[] };
export type KnightsRuleGuide = { intro?: string; sets: KnightsRuleSet[] };

/** Shared by the Config-page validator and the Knights reader; change both together via this object. */
export const KNIGHTS_RULE_GUIDE_LIMITS = {
  intro: 600,
  sets: 6,
  title: 60,
  notes: 600,
  points: 10,
  point: 300,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A trimmed, non-empty string within `max`, else undefined. */
const readText = (value: unknown, max: number) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
};

function readRuleSet(value: unknown): KnightsRuleSet | undefined {
  if (!isRecord(value)) return undefined;
  const title = readText(value.title, KNIGHTS_RULE_GUIDE_LIMITS.title);
  if (!title) return undefined;
  const points = (Array.isArray(value.points) ? value.points : [])
    .flatMap((point) => readText(point, KNIGHTS_RULE_GUIDE_LIMITS.point) ?? [])
    .slice(0, KNIGHTS_RULE_GUIDE_LIMITS.points);
  const notes = readText(value.notes, KNIGHTS_RULE_GUIDE_LIMITS.notes);
  if (!points.length && !notes) return undefined;
  return { title, ...(notes ? { notes } : {}), points };
}

/** Keeps the usable sets, points and intro; undefined when no set is usable. */
export function readRuleGuide(value: unknown): KnightsRuleGuide | undefined {
  if (!isRecord(value) || !Array.isArray(value.sets)) return undefined;
  const sets = value.sets
    .flatMap((set) => readRuleSet(set) ?? [])
    .slice(0, KNIGHTS_RULE_GUIDE_LIMITS.sets);
  if (!sets.length) return undefined;
  const intro = readText(value.intro, KNIGHTS_RULE_GUIDE_LIMITS.intro);
  return { ...(intro ? { intro } : {}), sets };
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Each Knights game setting the moderator Config page can store, with the environment variable it overrides. A field
 * that is not stored leaves Knights on that variable (or its built-in default). Number ranges match the Knights
 * environment readers (`hidden/config.ts`, `yesno/config.ts`, `trials/config.ts`), so a stored value is never one the environment would refuse.
 */
export const KNIGHTS_GAME_SETTINGS = {
  hiddenCheckRate: {
    kind: 'number',
    env: 'KNIGHTS_HIDDEN_CHECK_RATE',
    label: 'Skill check rate',
    range: 'from 0 to 1 (0 stops serving skill checks)',
    valid: (n: number) => n >= 0 && n <= 1,
  },
  hiddenCheckFailureWindowHours: {
    kind: 'number',
    env: 'KNIGHTS_HIDDEN_CHECK_FAILURE_WINDOW_HOURS',
    label: 'Failure window',
    range: 'greater than 0',
    valid: (n: number) => n > 0,
  },
  hiddenCheckSevereDistance: {
    kind: 'number',
    env: 'KNIGHTS_HIDDEN_CHECK_SEVERE_DISTANCE',
    label: 'Severe miss distance',
    range: 'a whole number greater than 0',
    valid: (n: number) => Number.isInteger(n) && n > 0,
  },
  hiddenCheckSettleDelayMinutes: {
    kind: 'number',
    env: 'KNIGHTS_HIDDEN_CHECK_SETTLE_DELAY_MINUTES',
    label: 'Settle delay',
    range: '0 or more',
    valid: (n: number) => n >= 0,
  },
  hiddenCheckRetireMinAnswers: {
    kind: 'number',
    env: 'KNIGHTS_HIDDEN_CHECK_RETIRE_MIN_ANSWERS',
    label: 'Answers before retiring',
    range: 'a whole number greater than 0',
    valid: (n: number) => Number.isInteger(n) && n > 0,
  },
  hiddenCheckRetireFailureRate: {
    kind: 'number',
    env: 'KNIGHTS_HIDDEN_CHECK_RETIRE_FAILURE_RATE',
    label: 'Retire failure rate',
    range: 'greater than 0, up to 1',
    valid: (n: number) => n > 0 && n <= 1,
  },
  yesNoStretch: {
    kind: 'number',
    env: 'KNIGHTS_YESNO_STRETCH',
    label: 'Questions per topic in a row',
    range: 'a whole number greater than 0',
    valid: (n: number) => Number.isInteger(n) && n > 0,
  },
  yesNoMaxAgeDays: {
    kind: 'number',
    env: 'KNIGHTS_YESNO_MAX_AGE_DAYS',
    label: 'Close unanswered after',
    range: 'greater than 0',
    valid: (n: number) => n > 0,
  },
  apprenticeSmites: {
    kind: 'toggle',
    env: 'KNIGHTS_APPRENTICE_SMITES',
    label: 'Acolyte wrong-answer smites',
  },
  shopDisabled: { kind: 'toggle', env: 'KNIGHTS_SHOP_DISABLED', label: 'Shop' },
  conversionDisabled: {
    kind: 'toggle',
    env: 'KNIGHTS_CONVERSION_DISABLED',
    label: 'Gold to Buzz conversion',
  },
  harvest: { kind: 'toggle', env: 'KNIGHTS_HARVEST', label: 'Harvest' },
  harvestHiddenCheckShare: {
    kind: 'number',
    env: 'KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE',
    label: 'Rulings used as skill checks',
    range: 'from 0 to 1',
    valid: (n: number) => n >= 0 && n <= 1,
  },
} as const;

type GameSettingSpec = (typeof KNIGHTS_GAME_SETTINGS)[keyof typeof KNIGHTS_GAME_SETTINGS];

export type KnightsGameSettingKey = keyof typeof KNIGHTS_GAME_SETTINGS;

export type KnightsGameSettings = {
  -readonly [K in KnightsGameSettingKey]?: (typeof KNIGHTS_GAME_SETTINGS)[K]['kind'] extends 'toggle'
    ? boolean
    : number;
};

export const KNIGHTS_GAME_SETTING_KEYS = Object.keys(
  KNIGHTS_GAME_SETTINGS
) as KnightsGameSettingKey[];

/** Toggles are booleans; numbers must be finite and in the setting's range. Nothing is coerced. */
export function isValidKnightsGameSetting(key: KnightsGameSettingKey, value: unknown): boolean {
  const spec: GameSettingSpec = KNIGHTS_GAME_SETTINGS[key];
  return spec.kind === 'toggle'
    ? typeof value === 'boolean'
    : isFiniteNumber(value) && spec.valid(value);
}

/** Keeps the usable fields only; undefined when none is, so an absent `game` reads back absent. */
function readGame(value: unknown): KnightsGameSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stored = value as Record<string, unknown>;
  const game: Record<string, number | boolean> = {};
  for (const key of KNIGHTS_GAME_SETTING_KEYS)
    if (isValidKnightsGameSetting(key, stored[key])) game[key] = stored[key] as number | boolean;
  return Object.keys(game).length ? (game as KnightsGameSettings) : undefined;
}

/** The rates used when the stored JSON omits one. Reading never turns a missing key on. */
export const KNIGHTS_SOURCES_DEFAULT_RATES = { sfwRate: 1, nsfwRate: 0.3 } as const;

export const KNIGHTS_SOURCES_DEFAULT_MAX_OPEN = 5000;
/** The highest open-item cap the moderator Config page accepts. */
export const KNIGHTS_SOURCES_MAX_OPEN_LIMIT = 1_000_000;

export const knightsSourcesMaxOpen = (config: KnightsSourcesConfig): number =>
  config.maxOpen ?? KNIGHTS_SOURCES_DEFAULT_MAX_OPEN;

const KNIGHTS_SOURCES_OFF: KnightsSourcesConfig = {
  enabled: false,
  ...KNIGHTS_SOURCES_DEFAULT_RATES,
};

const clampRate = (value: unknown, fallback: number) =>
  isFiniteNumber(value) ? Math.min(1, Math.max(0, value)) : fallback;

const readShare = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;

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
    const yesNoShare = readShare(config.yesNoShare);
    const game = readGame(config.game);
    const ruleGuide = readRuleGuide(config.ruleGuide);
    return {
      stored: true,
      config: {
        enabled: config.enabled === true,
        sfwRate: clampRate(config.sfwRate, KNIGHTS_SOURCES_DEFAULT_RATES.sfwRate),
        nsfwRate: clampRate(config.nsfwRate, KNIGHTS_SOURCES_DEFAULT_RATES.nsfwRate),
        // Left out when not stored, so the moderator page's three-field shape reads back unchanged.
        ...(maxOpen === undefined ? {} : { maxOpen }),
        ...(yesNoShare === undefined ? {} : { yesNoShare }),
        ...(game === undefined ? {} : { game }),
        ...(ruleGuide === undefined ? {} : { ruleGuide }),
      },
    };
  } catch {
    return off;
  }
}

export function parseKnightsSourcesConfig(raw: string | Buffer | null): KnightsSourcesConfig {
  return readKnightsSourcesConfig(raw).config;
}
