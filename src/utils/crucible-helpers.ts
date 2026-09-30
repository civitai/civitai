import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import {
  browsingLevelLabels,
  parseBitwiseBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { slugit } from '~/utils/string-helpers';

// Static routes beside `/crucibles/[id]/[[...slug]]` win over the slug, so a crucible whose name
// slugs to one of these would link to that page instead of its own.
const RESERVED_CRUCIBLE_SLUGS = new Set(['judge', 'edit']);

export function getCrucibleSlug(name: string) {
  const slug = slugit(name);
  return RESERVED_CRUCIBLE_SLUGS.has(slug) ? `${slug}-crucible` : slug;
}

/** The column is free text; anything but green reads as yellow, like challenges. */
export const toCrucibleBuzzType = (value: string): 'green' | 'yellow' =>
  value === 'green' ? 'green' : 'yellow';

export const getCrucibleUrl = (id: number, name: string) =>
  `/crucibles/${id}/${getCrucibleSlug(name)}`;

const ENDING_SOON_MS = 24 * 60 * 60 * 1000;

const STATUS_BADGES: Record<CrucibleStatus, { label: string; color: string }> = {
  [CrucibleStatus.Pending]: { label: 'Upcoming', color: 'blue' },
  [CrucibleStatus.Active]: { label: 'Active', color: 'green' },
  [CrucibleStatus.Completed]: { label: 'Completed', color: 'gray' },
  [CrucibleStatus.Cancelled]: { label: 'Cancelled', color: 'red' },
};

/** `status` stays Active until the finalize job runs, so an Active crucible is read against `endAt`. */
export function getCrucibleStatusBadge(
  status: CrucibleStatus,
  endAt: Date | null,
  now: Date = new Date()
) {
  if (status === CrucibleStatus.Active && endAt) {
    const msLeft = new Date(endAt).getTime() - now.getTime();
    if (msLeft <= 0) return { label: 'Ended', color: 'gray' };
    if (msLeft <= ENDING_SOON_MS) return { label: 'Ending soon', color: 'orange' };
  }
  return STATUS_BADGES[status];
}

/**
 * The single derivation of a crucible's prize pool: the creator's seed plus every entry fee
 * collected. Server and client both read it from here — `getFeaturedCrucible` restates it in raw
 * SQL because it sorts on the value, and that copy has to move with this one.
 *
 * Every field is required so a select that forgets `seededPrizePool` fails typecheck instead of
 * quietly under-reporting the pool.
 */
export function getCrucibleTotalPrizePool({
  entryFee,
  entryCount,
  seededPrizePool,
}: {
  entryFee: number;
  entryCount: number;
  seededPrizePool: number;
}): number {
  return seededPrizePool + entryFee * entryCount;
}

export type PrizePosition = {
  position: number;
  percentage: number;
};

/**
 * A place beyond the entry count has nobody to pay, so its share goes to the filled places in
 * proportion to their own shares — evenly when those shares are all 0%.
 */
export function getCruciblePrizeAmount({
  position,
  prizePositions,
  entryCount,
  totalPrizePool,
}: {
  position: number;
  prizePositions: PrizePosition[];
  entryCount: number;
  totalPrizePool: number;
}) {
  const prize = prizePositions.find((p) => p.position === position);
  if (!prize || position > entryCount) return 0;

  const sumOf = (positions: PrizePosition[]) => positions.reduce((sum, p) => sum + p.percentage, 0);
  const configured = sumOf(prizePositions);
  const filledPositions = prizePositions.filter((p) => p.position <= entryCount);
  const filled = sumOf(filledPositions);
  if (!filled) return Math.floor(((configured / 100) * totalPrizePool) / filledPositions.length);
  return Math.floor((prize.percentage / 100) * totalPrizePool * (configured / filled));
}

/**
 * `createCrucible` stores the `z.record(position, percentage)` its schema validates, so the value
 * is an object (`{"1": 50, "2": 30}`), not an array — an array-only read returns `[]` for every
 * crucible, which zeroes payouts and hides the prize split. Both shapes are accepted because
 * nothing type-checks across the JSON boundary.
 */
export function parsePrizePositions(prizePositionsJson: unknown): PrizePosition[] {
  if (!prizePositionsJson || typeof prizePositionsJson !== 'object') return [];

  if (Array.isArray(prizePositionsJson)) {
    return prizePositionsJson
      .filter(
        (item): item is PrizePosition =>
          typeof item === 'object' &&
          item !== null &&
          typeof item.position === 'number' &&
          typeof item.percentage === 'number'
      )
      .map(({ position, percentage }) => ({ position, percentage }))
      .filter(isUsablePrizePosition);
  }

  return Object.entries(prizePositionsJson)
    .map(([position, percentage]) => ({
      position: Number(position),
      percentage: Number(percentage),
    }))
    .filter(isUsablePrizePosition);
}

function isUsablePrizePosition({ position, percentage }: PrizePosition): boolean {
  return (
    Number.isInteger(position) && position > 0 && Number.isFinite(percentage) && percentage > 0
  );
}

/** A crucible's `nsfwLevel` is a bitmask of accepted ratings, not a single ordered level. */
export function getCrucibleRatings(nsfwLevel: number): string[] {
  const labels = parseBitwiseBrowsingLevel(nsfwLevel)
    .map((level) => browsingLevelLabels[level as keyof typeof browsingLevelLabels])
    .filter(Boolean);
  return labels.length ? labels : [browsingLevelLabels[0]];
}

export function getCrucibleRatingLabel(nsfwLevel: number): string {
  return getCrucibleRatings(nsfwLevel).join(' / ');
}
