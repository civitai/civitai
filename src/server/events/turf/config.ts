import * as z from 'zod';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import { scoreTierKey } from '~/shared/constants/creator-journey.constants';
import type { CreditStep, SupplyStep } from '~/server/events/turf/schedule';

// New accounts earn turf from this Creator Journey tier's threshold (its CreatorMilestone row). A
// missing row fails closed: none earn.
export const TURF_SCORE_TIER_KEY = scoreTierKey('spark');

// off: no placing, nothing earns. shadow: testers place and turf actions are recorded under
// `shadow:<type>` point types, which no weight can ever count (the referee reads only the types in
// the event's scoring config). live: turf actions record the real point types.

export const TURF_MODES = ['off', 'shadow', 'live'] as const;
export type TurfMode = (typeof TURF_MODES)[number];

export type EventTurfConfig = {
  mode: TurfMode;
  // Flipt flag naming who may place while the mode is shadow.
  testerFlag: string;
  supply: SupplyStep[];
  // How many of the leading team's earliest eligible stickerers one action on the image credits.
  creditedPlayers: CreditStep[];
  // Most stickers drawn on an image; the rest are counted, not drawn.
  renderLimit: number;
  // Most turf images an app server holds in memory. Past it, the least recently stickered drop out.
  mapMaxEntries: number;
};

// Every live override for one event, on sysRedis: a JSON object of the fields to replace.
export const turfConfigKey = (event: string) =>
  `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}:turf:config` as const;

const stepDate = z.coerce.date();
const overrideSchema = z
  .object({
    mode: z.enum(TURF_MODES),
    testerFlag: z.string().min(1),
    supply: z
      .array(
        z.object({
          from: stepDate,
          perHour: z.number().nonnegative(),
          cap: z.number().int().nonnegative(),
        })
      )
      .min(1),
    creditedPlayers: z
      .array(z.object({ from: stepDate, players: z.number().int().positive() }))
      .min(1),
    renderLimit: z.number().int().positive(),
    mapMaxEntries: z.number().int().positive(),
  })
  // Not strict: a key this build no longer knows (one an older build read) is dropped, rather than
  // failing the whole override and silently reverting every field to the event file.
  .partial();

/**
 * The event file's config with the live override applied. An override that does not parse is
 * ignored whole, so a typo can never half-apply; `invalid` says so for the caller to log.
 */
export function applyTurfOverride(base: EventTurfConfig, raw: string | null | undefined) {
  if (!raw) return { config: base, invalid: false };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { config: base, invalid: true };
  }
  const parsed = overrideSchema.safeParse(json);
  if (!parsed.success) return { config: base, invalid: true };
  return { config: { ...base, ...parsed.data }, invalid: false };
}
