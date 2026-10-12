import type { CrucibleJudgingStatus } from '~/server/schema/crucible.schema';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';
import { getBaseModelConfig } from '~/shared/constants/basemodel.constants';
import {
  CRUCIBLE_ENTRY_WARNING_PERCENT,
  crucibleRankingsAreFinal,
} from '~/shared/constants/crucible.constants';
import {
  allBrowsingLevelsFlag,
  browsingLevelLabels,
  getIsSafeBrowsingLevel,
  nsfwLevelColors,
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

/** How a prize is displayed. It is paid in whichever Buzz the winner picks when claiming. */
export const CRUCIBLE_PRIZE_BUZZ_TYPE = 'yellow' as const;

/**
 * A crucible's allowed levels as one range ("PG–XXX"), keyed to the highest for its colour. `null`
 * when a level in between is missing, since a range would claim it.
 */
export function getContentLevelRange(nsfwLevel: number) {
  const levels = parseBitwiseBrowsingLevel(nsfwLevel).filter((level) => level in nsfwLevelColors);
  if (!levels.length) return null;
  const lowest = levels[0];
  const highest = levels[levels.length - 1];
  // Levels are single bits, so an unbroken run is exactly highest*2 - lowest.
  if (levels.reduce((sum, level) => sum + level, 0) !== highest * 2 - lowest) return null;
  const label = (level: number) => browsingLevelLabels[level as keyof typeof browsingLevelLabels];
  return {
    label: lowest === highest ? label(lowest) : `${label(lowest)}–${label(highest)}`,
    level: highest,
  };
}

/** Shown where a crucible's description is expected; a blank description is stored as NULL. */
export const CRUCIBLE_NO_DESCRIPTION = 'No description provided';

/** An entrant pays in the currency of the site they enter on. */
export const getCrucibleEntryBuzzType = (isGreen: boolean): 'green' | 'yellow' =>
  isGreen ? 'green' : 'yellow';

/** The allowed-level values a crucible listed on the green site may have. */
export const CRUCIBLE_SFW_LEVELS = Array.from(
  { length: allBrowsingLevelsFlag },
  (_, i) => i + 1
).filter(getIsSafeBrowsingLevel);

/**
 * The green site lists only crucibles that accept nothing above PG-13 and whose text is SFW. Built on
 * the list the feed queries match, so the gates and the feed cannot disagree.
 */
export const isCrucibleSfw = ({ nsfwLevel, textNsfw }: { nsfwLevel: number; textNsfw: boolean }) =>
  CRUCIBLE_SFW_LEVELS.includes(nsfwLevel) && !textNsfw;

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

export type CrucibleNameScan = {
  name: string;
  ingestion: CrucibleIngestionStatus;
  textNsfw: boolean;
};

/**
 * Ledger rows and notifications can't be edited or retracted, and they show on both sites, so they
 * carry the name only once its text has passed the scan as safe for everyone.
 */
export const getCruciblePublishableName = (crucible: CrucibleNameScan) =>
  crucible.ingestion === CrucibleIngestionStatus.Scanned && !crucible.textNsfw
    ? crucible.name
    : null;

/** Without a publishable name, the row's link names the crucible. */
export function getCrucibleTransactionDescription(text: string, crucible: CrucibleNameScan) {
  if (getCruciblePublishableName(crucible) === null) return text;
  const room = BUZZ_DESCRIPTION_MAX_LENGTH - text.length - 2;
  if (crucible.name.length <= room) return `${text}: ${crucible.name}`;
  const cut = crucible.name.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${text}: ${cut.trimEnd()}…`;
}

const ENDING_SOON_MS = 24 * 60 * 60 * 1000;

export const CRUCIBLE_STATUS_BADGES: Record<CrucibleStatus, { label: string; color: string }> = {
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
  return CRUCIBLE_STATUS_BADGES[status];
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
    canRemoveEntries: !ended && isModerator && status === CrucibleStatus.Active,
  };
}

/**
 * Judging is blind: until a crucible ends, other people's entries show no creator and don't open
 * the image detail, which carries the creator, prompt and resources.
 */
export function canSeeCrucibleEntryDetails({
  status,
  isModerator,
  isOwnEntry,
}: {
  status: CrucibleStatus;
  isModerator: boolean;
  isOwnEntry: boolean;
}) {
  return isOwnEntry || isModerator || crucibleRankingsAreFinal(status);
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

export type CruciblePrizeWinner = {
  entryId: number;
  userId: number;
  position: number;
  prizePlace: number;
  prizeAmount: number;
};
export type CrucibleDisplayPrize = Omit<CruciblePrizeWinner, 'userId'>;

export const CRUCIBLE_ONE_PRIZE_RULE =
  'Each creator can win at most one prize. If you place more than once, your best entry counts and the next creator moves up.';

/**
 * Creators in finishing order, each represented by their best-placed entry. Prizes and average
 * finish both rank creators with this, so the two cannot disagree about where a creator finished.
 */
export function rankCreatorsByBestEntry<T extends { userId: number; position: number }>(
  placed: T[]
): T[] {
  const seen = new Set<number>();
  return [...placed]
    .sort((a, b) => a.position - b.position)
    .filter(({ userId }) => !seen.has(userId) && !!seen.add(userId));
}

/**
 * A creator takes at most one prize: their best-placed entry. Prize places go to creators in
 * placing order, so a creator's other entries keep their positions but the next creator moves up
 * a prize. Placings below the prize places don't change the result, so `placed` may be cut short
 * after the last prize place's creator.
 */
export function getCruciblePrizeWinners({
  placed,
  prizePositions,
  totalPrizePool,
}: {
  placed: { entryId: number; userId: number; position: number }[];
  prizePositions: PrizePosition[];
  totalPrizePool: number;
}): CruciblePrizeWinner[] {
  const lastPrizePlace = Math.max(0, ...prizePositions.map((p) => p.position));
  const creatorsBest = rankCreatorsByBestEntry(placed)
    .slice(0, lastPrizePlace)
    .map(({ entryId, userId, position }) => ({ entryId, userId, position }));

  return creatorsBest
    .map((entry, index) => ({ ...entry, prizePlace: index + 1 }))
    .filter(({ prizePlace }) => prizePositions.some((p) => p.position === prizePlace))
    .map((winner) => ({
      ...winner,
      prizeAmount: getCruciblePrizeAmount({
        position: winner.prizePlace,
        prizePositions,
        entryCount: creatorsBest.length,
        totalPrizePool,
      }),
    }));
}

/** Smaller fields are too coarse to place a creator in: 2nd of 3 says little about skill. */
export const AVG_FINISH_MIN_FIELD = 5;
/** Below this, one lucky crucible would read as the creator's standing. */
export const AVG_FINISH_MIN_CRUCIBLES = 3;

/** Where a creator finished among the creators who placed; null when the creator did not place. */
export function getCreatorFinish({
  placed,
  userId,
}: {
  placed: { userId: number; position: number }[];
  userId: number;
}): { rank: number; field: number } | null {
  const ranked = rankCreatorsByBestEntry(placed);
  const index = ranked.findIndex((creator) => creator.userId === userId);
  return index === -1 ? null : { rank: index + 1, field: ranked.length };
}

/**
 * A creator's average finish as "top X%" of the field, so entering big crucibles does not count
 * against them the way a win rate does. Null until there are enough crucibles to mean something.
 */
export function getAverageFinishTopPercent(finishes: { rank: number; field: number }[]) {
  const counted = finishes.filter(({ field }) => field >= AVG_FINISH_MIN_FIELD);
  if (counted.length < AVG_FINISH_MIN_CRUCIBLES) return null;

  const mean = counted.reduce((sum, { rank, field }) => sum + rank / field, 0) / counted.length;
  return Math.max(1, Math.round(mean * 100));
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

/**
 * The last `percent` of a crucible's run, when a new entry may not collect enough votes to place.
 * Defaults to the warning share a crucible gets unless its creator picks another.
 */
export function isCrucibleFinalStretch({
  startAt,
  endAt,
  percent = CRUCIBLE_ENTRY_WARNING_PERCENT.default,
  now = new Date(),
}: {
  startAt: Date | null;
  endAt: Date | null;
  percent?: number;
  now?: Date;
}) {
  if (!startAt || !endAt) return false;
  const end = new Date(endAt).getTime();
  const remaining = end - now.getTime();
  return remaining > 0 && remaining * 100 <= (end - new Date(startAt).getTime()) * percent;
}

/** When a crucible stops taking entries: `entryCutoffPercent` of its run before the end. */
export function getCrucibleEntriesCloseAt({
  startAt,
  endAt,
  entryCutoffPercent,
}: {
  startAt: Date | null;
  endAt: Date | null;
  entryCutoffPercent: number;
}): Date | null {
  if (!endAt) return null;
  const end = new Date(endAt).getTime();
  if (!startAt || !entryCutoffPercent) return new Date(end);
  const run = end - new Date(startAt).getTime();
  return new Date(end - Math.floor((run * entryCutoffPercent) / 100));
}

export function areCrucibleEntriesClosed(
  crucible: { startAt: Date | null; endAt: Date | null; entryCutoffPercent: number },
  now: Date = new Date()
) {
  const closeAt = getCrucibleEntriesCloseAt(crucible);
  return !!closeAt && now >= closeAt;
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

export type CrucibleJudgingBadge = { kind: 'available' | 'caughtUp'; label: string };

/** Only for crucibles the viewer has judged: on any other, every pair is still open. */
export function getCrucibleJudgingBadge(
  judging: Pick<CrucibleJudgingStatus, 'judged' | 'available' | 'votesUsedUp'> | undefined
): CrucibleJudgingBadge | null {
  if (!judging?.judged) return null;
  if (judging.available) return { kind: 'available', label: 'You have pairs to judge here' };
  if (judging.votesUsedUp) return { kind: 'caughtUp', label: "You're caught up here" };
  return null;
}
