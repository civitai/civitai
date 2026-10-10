import { isEqual } from 'lodash-es';
import * as z from 'zod';
import { NsfwLevel } from '~/server/common/enums';
import { crucibleImageSchema, type CrucibleImageSchema } from '~/server/schema/crucible.schema';
import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  CRUCIBLE_CONTENT_TYPES,
  CRUCIBLE_DEFAULT_DURATION,
  CRUCIBLE_DEFAULT_PRIZE_POSITIONS,
  CRUCIBLE_DESCRIPTION_MAX_LENGTH,
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_ENTRY_CUTOFF_PERCENT,
  CRUCIBLE_ENTRY_WARNING_PERCENT,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_MAX_PRIZE_POSITIONS,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_MAX_TOTAL_ENTRIES,
  CRUCIBLE_MIN_ENTRY_FEE,
  CRUCIBLE_MIN_TOTAL_ENTRIES,
  CRUCIBLE_NAME_MAX_LENGTH,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
  isCustomPrizeDistribution,
  type CrucibleContentType,
} from '~/shared/constants/crucible.constants';
import { Flags } from '~/shared/utils/flags';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  getCruciblePrizeAmount,
  getCrucibleTotalPrizePool,
  parsePrizePositions,
  type PrizePosition,
} from '~/utils/crucible-helpers';

export const CRUCIBLE_CREATE_STEP_COUNT = 4;
export const CRUCIBLE_CREATE_DRAFT_KEY = 'crucible_new';

export const entryFeeRangeLabel = `${CRUCIBLE_MIN_ENTRY_FEE.toLocaleString()}–${CRUCIBLE_MAX_ENTRY_FEE.toLocaleString()} Buzz`;

// The form's resolver rebuilds the schema from `.shape`, so object-level refines would be dropped:
// the cross-field rules live in `CrucibleUpsertWizard`'s step checks instead.
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
  freeEntriesPerUser: z.number().int().min(0).max(CRUCIBLE_MAX_ENTRIES),
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
  entryWarningPercent: z
    .number()
    .int()
    .min(CRUCIBLE_ENTRY_WARNING_PERCENT.min)
    .max(CRUCIBLE_ENTRY_WARNING_PERCENT.max),
  entryCutoffPercent: z
    .number()
    .int()
    .min(CRUCIBLE_ENTRY_CUTOFF_PERCENT.min)
    .max(CRUCIBLE_ENTRY_CUTOFF_PERCENT.max),
  allowedResources: z.array(z.number()).optional(),
  allowedBaseModels: z.array(z.string()).optional(),
  minViewSeconds: z.number().optional(),
  maxClipSeconds: z.number().optional(),
  seededPrizePool: z
    .number({ error: 'Enter 0 for no seed' })
    .int()
    .min(0)
    .max(CRUCIBLE_MAX_SEEDED_PRIZE_POOL),
  prizePositions: z.record(z.string(), z.number()),
  coverImage: crucibleImageSchema.nullish(),
  heroImage: crucibleImageSchema.nullish(),
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
  freeEntriesPerUser: 0,
  entryWarningPercent: CRUCIBLE_ENTRY_WARNING_PERCENT.default,
  entryCutoffPercent: CRUCIBLE_ENTRY_CUTOFF_PERCENT.default,
  allowedResources: [],
  allowedBaseModels: [],
  seededPrizePool: 0,
  prizePositions: { ...CRUCIBLE_DEFAULT_PRIZE_POSITIONS },
  coverImage: null,
  heroImage: null,
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
  freeEntriesPerUser: shape.freeEntriesPerUser.catch(defaults.freeEntriesPerUser),
  maxTotalEntries: shape.maxTotalEntries.catch(undefined),
  entryWarningPercent: shape.entryWarningPercent.catch(defaults.entryWarningPercent),
  entryCutoffPercent: shape.entryCutoffPercent.catch(defaults.entryCutoffPercent),
  seededPrizePool: shape.seededPrizePool.catch(defaults.seededPrizePool),
  prizePositions: shape.prizePositions.catch({ ...CRUCIBLE_DEFAULT_PRIZE_POSITIONS }),
  coverImage: shape.coverImage.catch(null),
  heroImage: shape.heroImage.catch(null),
  step: shape.step.catch(1),
});

/** `whenFullIsCeiling`: with free entries a full crucible may hold fewer paid ones. */
export type PlaceBuzz = { fromSeed?: number; whenFull?: number; whenFullIsCeiling?: boolean };

// Entry fees make the pool unknown at creation, so only the seed alone and a full crucible (every
// allowed entry paid) have amounts to show.
export function getPlaceBuzz({
  prizePositions,
  seededPrizePool,
  entryFee,
  maxTotalEntries,
  freeEntriesPerUser = 0,
}: {
  prizePositions: Record<string, number>;
  seededPrizePool: number;
  entryFee: number;
  maxTotalEntries?: number;
  freeEntriesPerUser?: number;
}): Record<string, PlaceBuzz> {
  const positions: PrizePosition[] = Object.entries(prizePositions).map(
    ([position, percentage]) => ({ position: Number(position), percentage })
  );
  const amountFor = (position: number, entryCount: number, totalPrizePool: number) =>
    getCruciblePrizeAmount({ position, prizePositions: positions, entryCount, totalPrizePool });
  const fullPool = maxTotalEntries
    ? getCrucibleTotalPrizePool({ entryFee, paidEntryCount: maxTotalEntries, seededPrizePool })
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
        whenFullIsCeiling: freeEntriesPerUser > 0 || undefined,
      },
    ])
  );
}

/** The seed comes from the creator's own Buzz; an edit refunds the seed already paid first. */
export function getMaxCrucibleSeed({
  balance,
  paidSeed = 0,
}: {
  balance: number;
  paidSeed?: number;
}) {
  return Math.min(CRUCIBLE_MAX_SEEDED_PRIZE_POOL, Math.max(0, Math.floor(balance)) + paidSeed);
}

export type CrucibleBuzzType = 'green' | 'yellow';

/** Mirrors the server's `isNonSfwForGreen`: a green crucible accepts SFW content only. */
export function restrictContentLevelsToBuzzType(buzzType: CrucibleBuzzType, nsfwLevel: number) {
  if (buzzType !== 'green' || !Flags.intersects(nsfwLevel, nsfwBrowsingLevelsFlag))
    return nsfwLevel;
  return Flags.intersection(nsfwLevel, sfwBrowsingLevelsFlag) || NsfwLevel.PG;
}

// Blue, green and yellow read as Buzz currencies, and teal/lime/indigo sit too close to them.
export const PRIZE_PLACE_COLORS = ['violet', 'pink', 'orange', 'cyan', 'grape', 'red'] as const;

export const getPrizePlaceColor = (index: number) =>
  PRIZE_PLACE_COLORS[index % PRIZE_PLACE_COLORS.length];

/** A place beyond the entry cap could never be filled. `0` is the form's "no cap". */
export const getPrizePlaceLimit = (maxTotalEntries: number | undefined) =>
  maxTotalEntries
    ? Math.min(maxTotalEntries, CRUCIBLE_MAX_PRIZE_POSITIONS)
    : CRUCIBLE_MAX_PRIZE_POSITIONS;

export function getCrucibleCostBreakdown(
  values: Pick<
    CrucibleCreateFormValues,
    'duration' | 'prizePositions' | 'allowedResources' | 'seededPrizePool'
  >
) {
  const duration = CRUCIBLE_DURATION_COSTS[values.duration] ?? 0;
  const prizeCustomization = isCustomPrizeDistribution(values.prizePositions)
    ? CRUCIBLE_PRIZE_CUSTOMIZATION_COST
    : 0;
  const resourceRequirements = values.allowedResources?.length
    ? CRUCIBLE_RESOURCE_REQUIREMENTS_COST
    : 0;
  const seed = values.seededPrizePool ?? 0;
  return {
    duration,
    prizeCustomization,
    resourceRequirements,
    seed,
    total: duration + prizeCustomization + resourceRequirements + seed,
  };
}

export function toCrucibleSubmitValues(values: CrucibleCreateFormValues) {
  const isVideo = values.contentType === MediaType.video;
  return {
    name: values.name.trim(),
    description: values.description?.trim() || undefined,
    coverImage: values.coverImage ?? undefined,
    heroImage: values.heroImage ?? undefined,
    nsfwLevel: values.nsfwLevel,
    contentType: values.contentType,
    entryFee: values.entryFee,
    entryLimit: values.entryLimit,
    freeEntriesPerUser: values.freeEntriesPerUser,
    maxTotalEntries: values.maxTotalEntries || undefined,
    entryWarningPercent: values.entryWarningPercent,
    entryCutoffPercent: values.entryCutoffPercent,
    allowedResources: values.allowedResources?.length ? values.allowedResources : undefined,
    allowedBaseModels: values.allowedBaseModels?.length ? values.allowedBaseModels : undefined,
    prizePositions: values.prizePositions,
    seededPrizePool: values.seededPrizePool,
    duration: values.duration,
    startAt: values.startAt ?? undefined,
    minViewSeconds: (isVideo && values.minViewSeconds) || undefined,
    maxClipSeconds: (isVideo && values.maxClipSeconds) || undefined,
  };
}

type CrucibleImageRow = { url: string; width: number | null; height: number | null } | null;

export type CrucibleEditSource = {
  name: string;
  description: string | null;
  duration: number;
  startAt: Date | null;
  nsfwLevel: number;
  contentType: MediaType;
  entryFee: number;
  entryLimit: number;
  freeEntriesPerUser: number;
  maxTotalEntries: number | null;
  entryWarningPercent: number;
  entryCutoffPercent: number;
  minViewSeconds: number | null;
  maxClipSeconds: number | null;
  seededPrizePool: number;
  prizePositions: unknown;
  allowedResources: unknown;
  allowedBaseModels: string[];
  image: CrucibleImageRow;
  heroImage: CrucibleImageRow;
};

const toFormImage = (image: CrucibleImageRow) =>
  image ? { url: image.url, width: image.width ?? 0, height: image.height ?? 0 } : null;

// `parsePrizePositions` drops 0% places, which would read a stored custom split as the default.
function toPrizePositionsRecord(prizePositions: unknown): Record<string, number> {
  if (prizePositions && typeof prizePositions === 'object' && !Array.isArray(prizePositions))
    return Object.fromEntries(
      Object.entries(prizePositions).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number'
      )
    );
  return Object.fromEntries(
    parsePrizePositions(prizePositions).map(({ position, percentage }) => [
      position.toString(),
      percentage,
    ])
  );
}

export function crucibleToFormValues(crucible: CrucibleEditSource): CrucibleCreateFormValues {
  return {
    name: crucible.name,
    description: crucible.description ?? '',
    // Stored in minutes; the form and the API take hours.
    duration: crucible.duration / 60,
    startAt: crucible.startAt,
    nsfwLevel: crucible.nsfwLevel,
    contentType: crucible.contentType === MediaType.video ? MediaType.video : MediaType.image,
    entryFee: crucible.entryFee,
    entryLimit: crucible.entryLimit,
    freeEntriesPerUser: crucible.freeEntriesPerUser,
    maxTotalEntries: crucible.maxTotalEntries ?? undefined,
    entryWarningPercent: crucible.entryWarningPercent,
    entryCutoffPercent: crucible.entryCutoffPercent,
    allowedResources: Array.isArray(crucible.allowedResources)
      ? crucible.allowedResources.filter((id): id is number => typeof id === 'number')
      : [],
    allowedBaseModels: crucible.allowedBaseModels,
    minViewSeconds: crucible.minViewSeconds ?? undefined,
    maxClipSeconds: crucible.maxClipSeconds ?? undefined,
    seededPrizePool: crucible.seededPrizePool,
    prizePositions: toPrizePositionsRecord(crucible.prizePositions),
    coverImage: toFormImage(crucible.image),
    heroImage: toFormImage(crucible.heroImage),
    step: 1,
  };
}

/** `null` clears a value; an absent key leaves it unchanged. */
export type CrucibleUpdateChanges = {
  name?: string;
  description?: string | null;
  coverImage?: CrucibleImageSchema;
  heroImage?: CrucibleImageSchema | null;
  nsfwLevel?: number;
  contentType?: CrucibleContentType;
  entryFee?: number;
  entryLimit?: number;
  freeEntriesPerUser?: number;
  maxTotalEntries?: number | null;
  entryWarningPercent?: number;
  entryCutoffPercent?: number;
  allowedResources?: number[];
  allowedBaseModels?: string[];
  prizePositions?: Record<string, number>;
  seededPrizePool?: number;
  duration?: number;
  startAt?: Date | null;
  minViewSeconds?: number | null;
  maxClipSeconds?: number | null;
};
export type CrucibleEditableField = keyof CrucibleUpdateChanges;

export const CRUCIBLE_EDITABLE_FIELDS = [
  'name',
  'description',
  'coverImage',
  'heroImage',
  'nsfwLevel',
  'contentType',
  'entryFee',
  'entryLimit',
  'freeEntriesPerUser',
  'maxTotalEntries',
  'entryWarningPercent',
  'entryCutoffPercent',
  'allowedResources',
  'allowedBaseModels',
  'prizePositions',
  'seededPrizePool',
  'duration',
  'startAt',
  'minViewSeconds',
  'maxClipSeconds',
] as const satisfies readonly CrucibleEditableField[];

export const CRUCIBLE_EDITABLE_WHILE_ACTIVE = [
  'name',
  'description',
  'coverImage',
  'heroImage',
] as const satisfies readonly CrucibleEditableField[];

export function getCrucibleEditableFields({
  canEditAll,
  canEditContentLevels,
}: {
  canEditAll: boolean;
  canEditContentLevels: boolean;
}): readonly CrucibleEditableField[] {
  if (canEditAll) return CRUCIBLE_EDITABLE_FIELDS;
  return canEditContentLevels
    ? [...CRUCIBLE_EDITABLE_WHILE_ACTIVE, 'nsfwLevel']
    : CRUCIBLE_EDITABLE_WHILE_ACTIVE;
}

const comparable = (field: CrucibleEditableField, value: unknown) =>
  field === 'coverImage' || field === 'heroImage'
    ? (value as CrucibleImageSchema | undefined)?.url
    : value;

export function getCrucibleUpdateChanges({
  initial,
  values,
  editableFields,
}: {
  initial: CrucibleCreateFormValues;
  values: CrucibleCreateFormValues;
  editableFields: readonly CrucibleEditableField[];
}): CrucibleUpdateChanges {
  const before = toCrucibleSubmitValues(initial);
  const after = toCrucibleSubmitValues(values);
  const changes: Record<string, unknown> = {};
  for (const field of editableFields) {
    if (isEqual(comparable(field, before[field]), comparable(field, after[field]))) continue;
    changes[field] =
      after[field] ?? (field === 'allowedResources' || field === 'allowedBaseModels' ? [] : null);
  }
  return changes as CrucibleUpdateChanges;
}
