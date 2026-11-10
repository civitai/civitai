import * as z from 'zod';
import { isoDatetimeCompat } from '@civitai/shared/iso-datetime-compat';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import { scoreTierKey } from '~/shared/constants/creator-journey.constants';
import type { CatchUpStep, CreditStep, SupplyStep } from '~/server/events/turf/schedule';

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
  // Scales each team's supply by how far its live points are from the teams' mean. None (or an empty
  // list) leaves supply as `supply` says.
  catchUp?: CatchUpStep[];
  // How many of the leading team's earliest eligible stickerers one action on the image credits.
  creditedPlayers: CreditStep[];
  // Scales `creditedPlayers` per leading team on the catch-up curve (scaleCredited). None: unscaled.
  creditedCatchUp?: CatchUpStep[];
  // Hours a sticker counts for, and the date its clock starts no earlier than (StickerExpiry).
  // No ttlHours: stickers never expire.
  ttlHours?: number;
  rolloutAt?: Date;
  // Most stickers drawn on an image; the rest are counted, not drawn.
  renderLimit: number;
  // Most stickers image detail draws however many pages are loaded (DEFAULT_DRAW_CEILING if unset).
  drawCeiling?: number;
  // Most turf images an app server holds in memory. Past it, the least recently stickered drop out.
  mapMaxEntries: number;
};

export const DEFAULT_DRAW_CEILING = 24;

// Every live override for one event, on sysRedis: a JSON object of the fields to replace.
export const turfConfigKey = (event: string) =>
  `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}:turf:config` as const;

const stepDate = z.coerce.date();
const catchUpStep = z.object({
  from: stepDate,
  max: z.number().min(1),
  min: z.number().min(0).max(1),
  gap: z.number().positive(),
});
export const overrideSchema = z
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
    catchUp: z.array(catchUpStep),
    creditedCatchUp: z.array(catchUpStep),
    ttlHours: z.number().positive(),
    // An ISO datetime only: coercing null, 0 or "0" reads as 1970 or 2000, and expires every old
    // sticker at once.
    rolloutAt: isoDatetimeCompat({ offset: true }).pipe(z.coerce.date()),
    creditedPlayers: z
      .array(z.object({ from: stepDate, players: z.number().int().positive() }))
      .min(1),
    renderLimit: z.number().int().positive(),
    drawCeiling: z.number().int().positive(),
    mapMaxEntries: z.number().int().positive(),
  })
  // Not strict: a key this build no longer knows (one an older build read) is dropped, rather than
  // failing the whole override and silently reverting every field to the event file.
  .partial()
  // Without rolloutAt, turning ttlHours on would expire every sticker older than ttlHours at once.
  .refine((o) => o.ttlHours === undefined || o.rolloutAt !== undefined, {
    message: 'ttlHours needs rolloutAt',
  });

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
