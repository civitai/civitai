import * as z from 'zod';
import { crucibleImageSchema } from '~/server/schema/crucible.schema';
import {
  CRUCIBLE_CONTENT_TYPES,
  CRUCIBLE_DEFAULT_DURATION,
  CRUCIBLE_DEFAULT_PRIZE_POSITIONS,
  CRUCIBLE_DESCRIPTION_MAX_LENGTH,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_MAX_TOTAL_ENTRIES,
  CRUCIBLE_MIN_ENTRY_FEE,
  CRUCIBLE_MIN_TOTAL_ENTRIES,
  CRUCIBLE_NAME_MAX_LENGTH,
} from '~/shared/constants/crucible.constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  getCruciblePrizeAmount,
  getCrucibleTotalPrizePool,
  type PrizePosition,
} from '~/utils/crucible-helpers';

export const CRUCIBLE_CREATE_STEP_COUNT = 4;
export const CRUCIBLE_CREATE_DRAFT_KEY = 'crucible_new';

export const entryFeeRangeLabel = `${CRUCIBLE_MIN_ENTRY_FEE.toLocaleString()}–${CRUCIBLE_MAX_ENTRY_FEE.toLocaleString()} Buzz`;

// The form's resolver rebuilds the schema from `.shape`, so object-level refines would be dropped:
// the cross-field rules live in the page's step checks instead.
export const crucibleCreateFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(CRUCIBLE_NAME_MAX_LENGTH),
  description: z.string().trim().max(CRUCIBLE_DESCRIPTION_MAX_LENGTH).optional(),
  duration: z.number(),
  startAt: z.date().nullish(),
  nsfwLevel: z.number(),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES),
  entryFee: z
    .number({ error: 'Entry fee is required' })
    .int()
    .min(CRUCIBLE_MIN_ENTRY_FEE, `Entry fee must be ${entryFeeRangeLabel}`)
    .max(CRUCIBLE_MAX_ENTRY_FEE, `Entry fee must be ${entryFeeRangeLabel}`),
  entryLimit: z.number().int().min(1).max(CRUCIBLE_MAX_ENTRIES),
  maxTotalEntries: z
    .number()
    .int()
    .min(0)
    .max(
      CRUCIBLE_MAX_TOTAL_ENTRIES,
      `At most ${CRUCIBLE_MAX_TOTAL_ENTRIES.toLocaleString()} entries`
    )
    .refine(
      (value) => value === 0 || value >= CRUCIBLE_MIN_TOTAL_ENTRIES,
      `At least ${CRUCIBLE_MIN_TOTAL_ENTRIES} entries are needed for judging`
    )
    .optional(),
  allowedResources: z.array(z.number()).optional(),
  minViewSeconds: z.number().optional(),
  maxClipSeconds: z.number().optional(),
  seededPrizePool: z
    .number({ error: 'Enter 0 for no seed' })
    .int()
    .min(0)
    .max(CRUCIBLE_MAX_SEEDED_PRIZE_POOL),
  prizePositions: z.record(z.string(), z.number()),
  coverImage: crucibleImageSchema.nullish(),
  step: z.number().int().min(1).max(CRUCIBLE_CREATE_STEP_COUNT),
});
export type CrucibleCreateFormValues = z.infer<typeof crucibleCreateFormSchema>;

export const crucibleCreateDefaultValues: CrucibleCreateFormValues = {
  name: '',
  description: '',
  duration: CRUCIBLE_DEFAULT_DURATION,
  nsfwLevel: 1,
  contentType: MediaType.image,
  entryFee: 100,
  entryLimit: 1,
  allowedResources: [],
  seededPrizePool: 0,
  prizePositions: { ...CRUCIBLE_DEFAULT_PRIZE_POSITIONS },
  coverImage: null,
  step: 1,
};

const { shape } = crucibleCreateFormSchema;
const defaults = crucibleCreateDefaultValues;

// A draft is saved mid-edit, so any field may hold a value the form would reject; each falls back
// on its own instead of failing the whole restore. `startAt` comes back from JSON as a string.
export const crucibleCreateDraftSchema = crucibleCreateFormSchema.extend({
  name: shape.name.catch(''),
  description: shape.description.catch(''),
  startAt: z.coerce
    .date<Date>()
    .refine((startAt) => startAt > new Date())
    .nullish()
    .catch(null),
  entryFee: shape.entryFee.catch(defaults.entryFee),
  entryLimit: shape.entryLimit.catch(defaults.entryLimit),
  maxTotalEntries: shape.maxTotalEntries.catch(undefined),
  seededPrizePool: shape.seededPrizePool.catch(defaults.seededPrizePool),
  prizePositions: shape.prizePositions.catch({ ...CRUCIBLE_DEFAULT_PRIZE_POSITIONS }),
  coverImage: shape.coverImage.catch(null),
  step: shape.step.catch(1),
});

export type PlaceBuzz = { fromSeed?: number; whenFull?: number };

// Entry fees make the pool unknown at creation, so only the seed alone and a full crucible (every
// allowed entry paid) have amounts to show.
export function getPlaceBuzz({
  prizePositions,
  seededPrizePool,
  entryFee,
  maxTotalEntries,
}: {
  prizePositions: Record<string, number>;
  seededPrizePool: number;
  entryFee: number;
  maxTotalEntries?: number;
}): Record<string, PlaceBuzz> {
  const positions: PrizePosition[] = Object.entries(prizePositions).map(
    ([position, percentage]) => ({ position: Number(position), percentage })
  );
  // A split whose filled places are all 0% divides by zero.
  const amountFor = (position: number, entryCount: number, totalPrizePool: number) =>
    getCruciblePrizeAmount({ position, prizePositions: positions, entryCount, totalPrizePool }) ||
    0;
  const fullPool = maxTotalEntries
    ? getCrucibleTotalPrizePool({ entryFee, entryCount: maxTotalEntries, seededPrizePool })
    : 0;

  return Object.fromEntries(
    positions.map(({ position }) => [
      position.toString(),
      {
        fromSeed:
          seededPrizePool > 0
            ? amountFor(position, maxTotalEntries ?? positions.length, seededPrizePool)
            : undefined,
        whenFull: maxTotalEntries ? amountFor(position, maxTotalEntries, fullPool) : undefined,
      },
    ])
  );
}
