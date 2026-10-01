import type { MediaType } from '~/shared/utils/prisma/enums';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';
import { getBaseModelConfig } from '~/shared/constants/basemodel.constants';
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

export const toCrucibleBuzzType = (value: string): 'green' | 'yellow' =>
  value === 'green' ? 'green' : 'yellow';

export const getCrucibleUrl = (id: number, name: string) =>
  `/crucibles/${id}/${getCrucibleSlug(name)}`;

/** "Other" (and any base model we don't know) says nothing about what it makes, so it passes. */
export function baseModelMakesMediaType(baseModel: string, mediaType: MediaType) {
  const { name, type } = getBaseModelConfig(baseModel);
  if (name === 'Other') return true;
  return Array.isArray(type) ? type.includes(mediaType) : type === mediaType;
}

// `buzzTransactionSchema` caps a description at 100 characters, and a crucible name alone can be 100.
const BUZZ_DESCRIPTION_MAX_LENGTH = 100;

/**
 * A ledger row can't be edited or retracted, and it shows on both sites, so the name goes in only
 * once its text has passed the scan as safe for everyone. Otherwise the row's link names the crucible.
 */
export function getCrucibleTransactionDescription(
  text: string,
  crucible: { name: string; ingestion: CrucibleIngestionStatus; textNsfw: boolean }
) {
  if (crucible.ingestion !== CrucibleIngestionStatus.Scanned || crucible.textNsfw) return text;
  const room = BUZZ_DESCRIPTION_MAX_LENGTH - text.length - 2;
  if (crucible.name.length <= room) return `${text}: ${crucible.name}`;
  const cut = crucible.name.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${text}: ${cut.trimEnd()}…`;
}

const ENDING_SOON_MS = 24 * 60 * 60 * 1000;

const STATUS_BADGES: Record<CrucibleStatus, { label: string; color: string }> = {
  [CrucibleStatus.Pending]: { label: 'Upcoming', color: 'blue' },
  [CrucibleStatus.Active]: { label: 'Active', color: 'green' },
  [CrucibleStatus.Completed]: { label: 'Completed', color: 'gray' },
  [CrucibleStatus.Cancelled]: { label: 'Cancelled', color: 'red' },
};

/**
 * `status` stays Active until the finalize job runs, so an Active crucible is read against `endAt`.
 * The shortest run is itself 24h, so "Ending soon" also needs the final stretch.
 */
export function getCrucibleStatusBadge(
  status: CrucibleStatus,
  { startAt, endAt }: { startAt: Date | null; endAt: Date | null },
  now: Date = new Date()
) {
  if (status === CrucibleStatus.Active && endAt) {
    const msLeft = new Date(endAt).getTime() - now.getTime();
    if (msLeft <= 0) return { label: 'Ended', color: 'gray' };
    if (msLeft <= ENDING_SOON_MS && isCrucibleFinalStretch({ startAt, endAt, now }))
      return { label: 'Ending soon', color: 'orange' };
  }
  return STATUS_BADGES[status];
}

/**
 * The single derivation of a crucible's prize pool: the creator's seed plus every entry fee
 * collected. Free entries pay nothing, so counting them would pay out Buzz nobody put in.
 * Server and client both read it from here — `getFeaturedCrucible` restates it in raw SQL because
 * it sorts on the value, and that copy has to move with this one.
 *
 * Every field is required so a select that forgets `seededPrizePool` fails typecheck instead of
 * quietly under-reporting the pool.
 */
export function getCrucibleTotalPrizePool({
  entryFee,
  paidEntryCount,
  seededPrizePool,
}: {
  entryFee: number;
  paidEntryCount: number;
  seededPrizePool: number;
}): number {
  return seededPrizePool + entryFee * paidEntryCount;
}

/** How free entries read to an entrant; `null` when there are none. */
export function getFreeEntriesLabel({
  freeEntriesPerUser,
  entryLimit,
}: {
  freeEntriesPerUser: number;
  entryLimit: number;
}) {
  if (freeEntriesPerUser <= 0) return null;
  if (freeEntriesPerUser >= entryLimit) return 'Free to enter';
  return freeEntriesPerUser === 1 ? 'First entry free' : `First ${freeEntriesPerUser} entries free`;
}

/** Buzz charged for someone's next `count` entries, given how many they've already made. */
export function getCrucibleEntriesCost({
  entriesSoFar,
  count,
  freeEntriesPerUser,
  entryFee,
}: {
  entriesSoFar: number;
  count: number;
  freeEntriesPerUser: number;
  entryFee: number;
}) {
  const freeLeft = Math.max(0, freeEntriesPerUser - entriesSoFar);
  return Math.max(0, count - freeLeft) * entryFee;
}

/** Whether a person's next entry is free, given how many they've already made. */
export function isFreeCrucibleEntry({
  entriesSoFar,
  freeEntriesPerUser,
}: {
  entriesSoFar: number;
  freeEntriesPerUser: number;
}) {
  return entriesSoFar < freeEntriesPerUser;
}

const formatDuration = (ms: number) => {
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

/** An upcoming crucible counts down to its start, a running one to its end. */
export function getCrucibleCountdown({
  status,
  startAt,
  endAt,
  now = new Date(),
}: {
  status: CrucibleStatus;
  startAt: Date | null;
  endAt: Date | null;
  now?: Date;
}): { label: 'Starts In' | 'Time Left'; value: string; at: Date | null } {
  if (status === CrucibleStatus.Pending && startAt) {
    const msToStart = new Date(startAt).getTime() - now.getTime();
    return {
      label: 'Starts In',
      value: msToStart > 0 ? formatDuration(msToStart) : 'Starting',
      at: new Date(startAt),
    };
  }
  const msToEnd = endAt ? new Date(endAt).getTime() - now.getTime() : 0;
  const running = status === CrucibleStatus.Active && msToEnd > 0;
  return {
    label: 'Time Left',
    value: running ? formatDuration(msToEnd) : endAt ? 'Ended' : '-',
    at: endAt ? new Date(endAt) : null,
  };
}

/** Nothing is managed once a crucible ends, including one past `endAt` that isn't finalized yet. */
export function getCrucibleManageActions({
  status,
  endAt,
  isCreator,
  isModerator,
  now = new Date(),
}: {
  status: CrucibleStatus;
  endAt: Date | null;
  isCreator: boolean;
  isModerator: boolean;
  now?: Date;
}) {
  const ended =
    status === CrucibleStatus.Completed ||
    status === CrucibleStatus.Cancelled ||
    (!!endAt && new Date(endAt) <= now);
  const isPending = status === CrucibleStatus.Pending;
  return {
    canEdit:
      !ended && (isModerator || (isCreator && (isPending || status === CrucibleStatus.Active))),
    canCancel: !ended && (isModerator || (isCreator && isPending)),
  };
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

export const CRUCIBLE_MIN_VOTES_PERCENT = 75;

/** Votes an entry needs to place: a share of the average per entry, so late entries can't win unjudged. */
export function getCrucibleMinVotes({
  totalVotes,
  entryCount,
}: {
  totalVotes: number;
  entryCount: number;
}) {
  if (!entryCount) return 0;
  // Integer division keeps an exact share exact; a float 0.75 × average can land just above it.
  return Math.ceil((totalVotes * CRUCIBLE_MIN_VOTES_PERCENT) / (entryCount * 100));
}

const FINAL_STRETCH_FRACTION = 0.2;

/** The last fifth of a crucible's run, when a new entry may not collect enough votes to place. */
export function isCrucibleFinalStretch({
  startAt,
  endAt,
  now = new Date(),
}: {
  startAt: Date | null;
  endAt: Date | null;
  now?: Date;
}) {
  if (!startAt || !endAt) return false;
  const end = new Date(endAt).getTime();
  const remaining = end - now.getTime();
  return remaining > 0 && remaining <= (end - new Date(startAt).getTime()) * FINAL_STRETCH_FRACTION;
}

/**
 * A completed crucible is ranked by its placings, with entries that didn't get enough votes to
 * place after them and unranked. A cancelled one placed nobody, so it ranks by score.
 */
export function rankCrucibleEntries<T extends { score: number | null; position: number | null }>(
  entries: T[],
  { completed }: { completed: boolean }
): (T & { rank: number | null })[] {
  const byScore = (a: T, b: T) => (b.score ?? 0) - (a.score ?? 0);
  if (!completed)
    return [...entries].sort(byScore).map((entry, index) => ({ ...entry, rank: index + 1 }));

  return [...entries]
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || byScore(a, b))
    .map((entry) => ({ ...entry, rank: entry.position }));
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
