/**
 * Community-pick scoring for contest collections.
 *
 * Each entry (a CollectionItem carrying a modelId) is scored by counting DISTINCT
 * QUALIFIED USERS per signal inside the contest window, normalized within its
 * category, then weighted. Distinct-user counting IS the anti-cheat: one account
 * contributes at most 1 to any signal, so volume farming collapses to 1.
 *
 * Categories are separate contests — normalization and ranking never cross a
 * category boundary, so raw volume is never compared across them.
 *
 * Every version-scoped signal counts only QUALIFYING versions: created inside the
 * contest window, on a configured base model. An already-existing model may enter with
 * a new version, so crediting the whole model hands an entry its own back catalogue.
 * Collects are the one exception and stay model-level — see `countCollectors`.
 *
 * Every count is computed IN the database. No user-id array ever crosses into
 * Node: the age gate becomes a `userId <= threshold` pushdown, and the (small)
 * disqualified set is pushed into each query as a literal id list.
 *
 * Weights and thresholds are NOT in this file and have no code default. They live
 * in `contestScoring:<collectionId>` (falling back to `contestScoring:default`);
 * this module fails loudly when neither row exists. They are recorded in every
 * snapshot and stripped from every response.
 */

import type { Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import {
  CacheTTL,
  CONTEST_SCORE_CODE_VERSION,
  CONTEST_SNAPSHOT_KEY_PREFIX,
  KEY_VALUE_KEYS,
} from '~/server/common/constants';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { collectionMetadataSchema } from '~/server/schema/collection.schema';
import type {
  ContestScoreRunState,
  ContestScoringConfig,
  ContestScoringScope,
  CreateContestSnapshotInput,
  GetCommunityScoreInput,
  GetContestCandidatesInput,
  ContestScoreSignal,
  RunCommunityScoreInput,
  SetContestScoringConfigInput,
} from '~/server/schema/contest-score.schema';
import {
  contestScoreSignals,
  contestScoringConfigSchema,
} from '~/server/schema/contest-score.schema';
// Every query this service runs lives next door. The dependency is one-way: nothing in
// `contest-score.queries` imports from here, so the shared types and the error class
// live there rather than being passed back and forth.
import {
  chCandidateSources,
  chSignalSources,
  collectChEngagers,
  ContestScoringError,
  countCollectors,
  countImageAuthors,
  DEFAULT_STATUSES,
  intList,
  loadBaseGates,
  loadCategoryTotals,
  loadEntries,
  loadEntryImages,
  loadImagePairs,
  loadQualifyingVersions,
  requireClickhouse,
  resolveBannedEngagers,
  runChCounts,
  runChPerCreator,
  toImagePairs,
  type ContestBoundSource,
  type EntryImage,
  type EntryRow,
  type Gates,
  type ResolvedWindow,
  type SignalCount,
  type WindowInput,
} from '~/server/services/contest-score.queries';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { Availability, CollectionMode } from '~/shared/utils/prisma/enums';
import type { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { signalClient } from '~/utils/signal-client';
import { hashifyObject } from '~/utils/string-helpers';

// Re-exported so callers that already import these from the service keep working; the
// definitions live next door with the queries that use them.
export type { ResolvedWindow, ContestBoundSource } from '~/server/services/contest-score.queries';
export { ContestScoringError } from '~/server/services/contest-score.queries';

type Signal = ContestScoreSignal;

/**
 * Comments and tips are deliberately unweighted: both are trivially launderable
 * (a tip can be sent back out of band).
 */
export const CONTEST_SIGNAL_SOURCES: Record<Signal, string> = {
  imageAuthors: "Distinct authors of on-site images made with the entry's versions",
  reactors: 'Distinct users reacting to those images',
  downloaders: "Distinct users downloading the entry's versions",
  generators: "Distinct users generating with the entry's versions",
  collectors: 'Distinct users adding the model to another collection',
};

// Decimal places the UI renders a score to. Scores are carried at 4, so two rows can
// read identically on screen while holding different ranks; entries that straddle that
// boundary are flagged rather than silently rounded together.
const SCORE_DISPLAY_PRECISION = 3;
// A finished run stays readable for a day so the tab opens on the last result rather
// than on an empty table waiting for a fresh run.
const RESULT_TTL = CacheTTL.day;
const RUN_STATE_TTL = CacheTTL.hour;
// The lock has to outlast the work it guards: the age-threshold query alone is ~12s
// and a full run can run for minutes. It is renewed on a timer as well, so this is a
// backstop for a dead holder rather than a deadline for a live one.
const RUN_LOCK_TTL = 600;
const RUN_HEARTBEAT_INTERVAL = 15;
const RUN_STALE_AFTER = 60;
// Ceiling on the reactor lookup table, which scales with images published in the
// window rather than with entry count. Past it the run is flagged truncated.
const MAX_IMAGE_PAIRS = 200000;

function safeErrorMessage(collectionId: number, e: unknown) {
  if (e instanceof ContestScoringError) return e.message;
  const error = e as Error;
  logToAxiom(
    { name: 'contest-score', type: 'error', collectionId, message: error?.message },
    'civitai-prod'
  ).catch(() => null);
  console.error('[contest-score] failed', collectionId, error?.message);
  return 'Contest scoring failed. See server logs.';
}

function sanitizeError(collectionId: number, e: unknown): never {
  if (e instanceof ContestScoringError) throw throwBadRequestError(e.message);
  throw new Error(safeErrorMessage(collectionId, e));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configKey = (suffix: number | 'default') => `${KEY_VALUE_KEYS.CONTEST_SCORING}:${suffix}`;
const scopeSuffix = (scope: ContestScoringScope, collectionId: number) =>
  scope === 'global' ? ('default' as const) : collectionId;

type ResolvedConfig = { config: ContestScoringConfig; scope: ContestScoringScope };

function parseConfig(collectionId: number, stored: unknown): ContestScoringConfig {
  const parsed = contestScoringConfigSchema.safeParse(stored);
  if (!parsed.success)
    throw new ContestScoringError(
      `The contest scoring config for collection ${collectionId} is malformed: ${parsed.error.message}`
    );
  return parsed.data;
}

/**
 * Per-collection config with a global fallback. One shared row would let a later
 * edit retroactively change a finished contest's ranking.
 *
 * The winning SCOPE travels with the config because it is part of the run's cache
 * identity: a fresh per-collection row can carry a lower `version` than the global
 * one it overrides, so version alone would let the collection-scoped run collide with
 * a stale globally-scoped one.
 */
async function resolveContestScoringConfig(collectionId: number): Promise<ResolvedConfig> {
  const [specific, fallback] = await Promise.all([
    dbKV.get<unknown>(configKey(collectionId)),
    dbKV.get<unknown>(configKey('default')),
  ]);

  if (!specific && !fallback)
    throw new ContestScoringError(
      `Contest scoring is not configured: neither "${configKey(collectionId)}" nor "${configKey(
        'default'
      )}" exists in KeyValue. Weights and thresholds live only in the database — there is no code fallback.`
    );

  return specific
    ? { config: parseConfig(collectionId, specific), scope: 'collection' }
    : { config: parseConfig(collectionId, fallback), scope: 'global' };
}

export async function getContestScoringConfig(collectionId: number): Promise<ContestScoringConfig> {
  return (await resolveContestScoringConfig(collectionId)).config;
}

/**
 * The moderator-facing read. Deliberately a SEPARATE procedure from the scoring
 * query: the score payload carries no weights, denominators or thresholds, so
 * relaxing the gate on one endpoint cannot expose the other.
 */
export async function getContestScoringConfigForEditor(collectionId: number) {
  try {
    const [specific, fallback] = await Promise.all([
      dbKV.get<unknown>(configKey(collectionId)),
      dbKV.get<unknown>(configKey('default')),
    ]);

    return {
      collectionId,
      effectiveScope: (specific ? 'collection' : 'global') as ContestScoringScope,
      collection: specific ? parseConfig(collectionId, specific) : null,
      global: fallback ? parseConfig(collectionId, fallback) : null,
    };
  } catch (e) {
    return sanitizeError(collectionId, e);
  }
}

/**
 * Append-only audit rows, one per edit:
 *   contestScoring:audit:<collectionId|default>:<ISO>
 *
 * Written with `create` inside the same transaction as the config write, so a
 * config change that is not accompanied by an audit row cannot exist. `create` and
 * not `upsert`: colliding on an existing row must fail loudly rather than silently
 * rewrite history.
 */
const auditKey = (suffix: number | 'default', at: string) =>
  `${KEY_VALUE_KEYS.CONTEST_SCORING}:audit:${suffix}:${at}`;

export async function setContestScoringConfig({
  input,
  userId,
  username,
}: {
  input: SetContestScoringConfigInput;
  userId: number;
  username?: string | null;
}) {
  const { collectionId, scope, config, reason } = input;
  try {
    // A base-model list is a single contest's rule. On the global row it would apply to
    // every contest that has no config of its own, and any whose entries are built on
    // anything else would go wholly ineligible behind a reason that reads like a
    // finding rather than a misconfiguration.
    if (scope === 'global' && config.baseModels?.length)
      throw new ContestScoringError(
        'Base models cannot be set on the global config — they are specific to one contest. Save them to this contest only, or set them on the collection itself.'
      );

    const suffix = scopeSuffix(scope, collectionId);
    const key = configKey(suffix);

    const [existingRaw, defaultRaw] = await Promise.all([
      dbKV.get<unknown>(key),
      dbKV.get<unknown>(configKey('default')),
    ]);
    const existing = existingRaw ? parseConfig(collectionId, existingRaw) : null;
    const globalConfig = defaultRaw ? parseConfig(collectionId, defaultRaw) : null;

    // Above BOTH rows, never just the one being written. A per-collection row that
    // started below the global version could otherwise mint a cache identity a
    // previous run already used.
    const version = Math.max(existing?.version ?? 0, globalConfig?.version ?? 0) + 1;
    const updatedAt = new Date().toISOString();
    // Through the READER's schema, not just the mutation input's. The input covers
    // the editable fields; this is the row a run will actually parse, so a write that
    // the reader would reject must fail here rather than at the next run.
    const next = parseConfig(collectionId, {
      ...config,
      version,
      updatedById: userId,
      updatedByUsername: username ?? null,
      updatedAt,
    });

    await dbWrite.$transaction([
      dbWrite.keyValue.upsert({
        where: { key },
        create: { key, value: next as unknown as Prisma.InputJsonValue },
        update: { value: next as unknown as Prisma.InputJsonValue },
      }),
      dbWrite.keyValue.create({
        data: {
          key: auditKey(suffix, updatedAt),
          value: {
            userId,
            username: username ?? null,
            scope,
            collectionId,
            ...(reason ? { reason } : {}),
            before: existing,
            after: next,
          } as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    // The version bump already orphans every result key this collection had cached
    // (version is part of the key), so the stale result is unreachable and TTLs out.
    // Dropping the run pointer is what stops the UI from presenting it as current.
    await clearLatestRun(collectionId);

    return { scope, version, updatedAt };
  } catch (e) {
    return sanitizeError(collectionId, e);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Derived from the collection's own contest metadata, never defaulted. An absent
 * window silently becoming "all time" would switch the age gate off, which is the
 * worst way for this to fail.
 */
async function resolveWindow(
  collectionId: number,
  input: { start?: Date; end?: Date },
  config: ContestScoringConfig
): Promise<ResolvedWindow> {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { id: true, mode: true, metadata: true, createdAt: true },
  });
  if (!collection) throw new ContestScoringError(`Collection ${collectionId} not found`);
  if (collection.mode !== CollectionMode.Contest)
    throw new ContestScoringError(`Collection ${collectionId} is not a contest collection`);

  // A hard failure, never a silent `{}`. Eligibility reads two metadata fields, and a
  // fallback shape would drop the contest start to the display window AND empty the
  // declared base models — handing the rule back to the config row — with nothing on
  // screen to say so. This is reachable: the schema refines `baseModels` against
  // `basemodel.constants.ts`, so retiring a base model stops every contest naming it
  // from parsing.
  const parsed = collectionMetadataSchema.safeParse(collection.metadata ?? {});
  if (!parsed.success)
    throw new ContestScoringError(
      `Collection ${collectionId} has contest metadata that no longer parses, so its contest window and base models cannot be trusted: ${parsed.error.message}`
    );
  const metadata = parsed.data;

  // The contest's own bounds, and NEVER the display window: these decide the age gate
  // and which versions qualify, so letting them fall back to the date pickers would
  // hand eligibility to whoever is looking at the screen. The two bounds resolve
  // independently — the common `endsAt`-only shape satisfies the end while leaving the
  // start with no submission date at all — so each carries its own fallback.
  //
  // `Collection.createdAt` is the backstop because it is structural and cannot be
  // nudged: a contest's entries cannot predate the collection holding them. Where even
  // that is unavailable the run refuses rather than scoring against an arbitrary line.
  const contestStart = metadata.submissionStartDate ?? collection.createdAt;
  const contestStartSource: ContestBoundSource = metadata.submissionStartDate
    ? 'submissionStartDate'
    : 'collectionCreatedAt';
  const contestEnd = metadata.submissionEndDate ?? metadata.endsAt;
  const contestEndSource: ContestBoundSource = metadata.submissionEndDate
    ? 'submissionEndDate'
    : 'endsAt';
  if (!contestStart)
    throw new ContestScoringError(
      `Collection ${collectionId} has no submissionStartDate and no creation date, so there is no trustworthy start for deciding which versions qualify.`
    );
  if (!contestEnd)
    throw new ContestScoringError(
      `Collection ${collectionId} has neither submissionEndDate nor endsAt, so there is no trustworthy end for deciding which versions qualify. An explicit window end only narrows the view; it cannot define the contest.`
    );

  // The display window defaults to the whole contest. Resolved AFTER the bounds above
  // and from them, so a contest carrying only an `endsAt` scores without a moderator
  // having to invent a start date — one that no longer affects eligibility and so would
  // be asking them to supply a number that changes nothing.
  const start = input.start ?? contestStart;
  const end = input.end ?? contestEnd;

  const ageCutoff = new Date(contestStart.getTime() - config.ageGateDays * 24 * 60 * 60 * 1000);

  // Belt and braces behind the schema's `nonnegative()`: a row written before that
  // existed would push the cutoff past the contest start, and the age gate would
  // admit every account on the site while the run still looked normal.
  if (ageCutoff > contestStart)
    throw new ContestScoringError(
      'The configured age gate resolves to a cutoff after the contest start, which would disable the gate entirely. Fix the scoring config before running.'
    );

  const now = new Date();
  const partial = end > now;

  return {
    start,
    end,
    effectiveEnd: partial ? now : end,
    partial,
    ageCutoff,
    contestStart,
    contestEnd,
    contestStartSource,
    contestEndSource,
    declaredBaseModels: metadata.baseModels?.filter(Boolean) ?? [],
  };
}

export type ResolvedBaseModels = {
  baseModels: string[];
  source: 'collection' | 'config' | 'none';
};

/**
 * The collection's metadata wins over the scoring config, because it is the rule the
 * submission validator rejected entrants against and the one the contest settings UI
 * publishes. The config field is the fallback for a contest whose metadata declares
 * none. The two CAN disagree, so the winning source travels with the answer and is
 * recorded in the snapshot rather than left to be re-derived.
 */
function resolveBaseModels(
  window: ResolvedWindow,
  config: ContestScoringConfig
): ResolvedBaseModels {
  if (window.declaredBaseModels.length)
    return { baseModels: window.declaredBaseModels, source: 'collection' };

  const configured = config.baseModels?.filter(Boolean) ?? [];
  return configured.length
    ? { baseModels: configured, source: 'config' }
    : { baseModels: [], source: 'none' };
}

function ineligibilityReason(
  entry: EntryRow,
  qualifyingVersions: number,
  baseModelFilterApplied: boolean
) {
  if (entry.modelDeleted) return 'Model deleted';
  if (entry.modelStatus !== 'Published') return `Model ${entry.modelStatus.toLowerCase()}`;
  if (entry.modelAvailability === Availability.Private) return 'Model is private';
  // Only claims a base-model rule when one actually ran, so the reason never asserts a
  // requirement the contest never had.
  if (!qualifyingVersions)
    return baseModelFilterApplied
      ? 'No published version was created during the contest on a qualifying base model'
      : 'No published version was created during the contest';
  return null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ContestScoreEntry = {
  /** Null when the entry is ineligible, or when its whole category is tied at zero. */
  rank: number | null;
  collectionItemId: number;
  modelId: number;
  modelName: string;
  creatorId: number;
  creatorUsername: string | null;
  status: string;
  eligible: boolean;
  ineligibleReason: string | null;
  /**
   * Versions of the model that represent this entry. Recorded so a disputed placement
   * can be explained without re-deriving which versions the run counted.
   */
  qualifyingVersionCount: number;
  image: EntryImage | null;
  // No `normalized` here: alongside `score`, five normalized values and five scores
  // solve for the five weights. The UI never rendered it.
  //
  // ⚠️ Dropping it does NOT make this payload weight-safe. Normalization is
  // max-within-category, so a caller holding every entry in a category can
  // reconstruct each maximum from `qualified` and solve for the weights from
  // `score`. `moderatorProcedure` on every procedure is what actually closes the
  // oracle. Do not relax that gate on the belief that the payload is safe alone.
  signals: Record<Signal, { raw: number; qualified: number }>;
  rawTotal: number;
  qualifiedTotal: number;
  disqualifiedShare: number;
  score: number;
  /** Another eligible entry holds this exact score and therefore this exact rank. */
  sharedRank: boolean;
  /** An adjacent entry's score differs only below the precision the UI renders. */
  belowDisplayPrecision: boolean;
};

export type ContestScoreCategory = {
  tagId: number | null;
  tagName: string | null;
  entryCount: number;
  eligibleCount: number;
  /** A lone entrant normalizes to 1.0 on every non-zero signal — not a comparable score. */
  soloEntry: boolean;
  /** Nothing in this category scored: ranks are withheld rather than invented. */
  tied: boolean;
  /** Entries in this category were lost to the entry cap, so its ranks are withheld. */
  truncated: boolean;
  missingCount: number;
  entries: ContestScoreEntry[];
};

export type ContestCommunityScore = {
  collectionId: number;
  generatedAt: string;
  /** The DISPLAY window — which traffic was counted. */
  window: { start: string; end: string; effectiveEnd: string };
  /**
   * The contest itself — which versions qualified, and therefore who was eligible.
   * Distinct from `window` on purpose: a moderator narrowing the pickers changes the
   * former and must never change the latter, and the header says which is which.
   */
  eligibility: {
    start: string;
    end: string;
    startSource: ContestBoundSource;
    endSource: ContestBoundSource;
  };
  partial: boolean;
  statuses: CollectionItemStatus[];
  entryCount: number;
  truncated: { entries: boolean; images: boolean };
  /**
   * Set when a bound was hit and part of the qualification was skipped. Degrading
   * loudly matters more than degrading gracefully for an artifact that decides a
   * prize.
   */
  degraded: { bannedRefinementSkipped: boolean };
  signalSources: Record<Signal, string>;
  categories: ContestScoreCategory[];
};

function emptySignals() {
  return Object.fromEntries(
    contestScoreSignals.map((s) => [s, { raw: 0, qualified: 0 }])
  ) as ContestScoreEntry['signals'];
}

/** Filled in during a run for the snapshot's audit trail; never sent to a client. */
type RunAudit = {
  engagerCount: number;
  ageGateBandUsers: number;
  /** Resolved rather than read back off the config, which may not carry the field. */
  baseModels: string[];
  /** Which of the two rule sources won — they can disagree. */
  baseModelSource: ResolvedBaseModels['source'];
};

/**
 * What a run actually used, returned rather than re-derived by the caller.
 *
 * Callers used to resolve the config themselves and pair it with a score computed
 * against a SECOND, independent resolution. A config saved while a run waited on the
 * lock produced a snapshot attesting to weights that never produced its ranking — in
 * the one row that would defend a disputed prize — and stranded a run's result under
 * a cache key derived from the wrong version.
 */
type RunOutcome = {
  score: ContestCommunityScore;
  config: ContestScoringConfig;
  scope: ContestScoringScope;
  window: ResolvedWindow;
  audit: RunAudit;
};

async function computeCommunityScore(input: WindowInput): Promise<RunOutcome> {
  requireClickhouse();
  const { config, scope } = await resolveContestScoringConfig(input.collectionId);
  const window = await resolveWindow(input.collectionId, input, config);
  const statuses = input.statuses ?? DEFAULT_STATUSES;
  const { baseModels, source: baseModelSource } = resolveBaseModels(window, config);
  const audit: RunAudit = {
    engagerCount: 0,
    ageGateBandUsers: 0,
    baseModels,
    baseModelSource,
  };

  const base = {
    collectionId: input.collectionId,
    generatedAt: new Date().toISOString(),
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      effectiveEnd: window.effectiveEnd.toISOString(),
    },
    eligibility: {
      start: window.contestStart.toISOString(),
      end: window.contestEnd.toISOString(),
      startSource: window.contestStartSource,
      endSource: window.contestEndSource,
    },
    partial: window.partial,
    statuses,
    signalSources: CONTEST_SIGNAL_SOURCES,
  };

  const [{ entries, truncated }, categoryTotals] = await Promise.all([
    loadEntries(input),
    loadCategoryTotals(input),
  ]);
  if (!entries.length)
    return {
      score: {
        ...base,
        entryCount: 0,
        truncated: { entries: truncated, images: false },
        degraded: { bannedRefinementSkipped: false },
        categories: [],
      },
      config,
      scope,
      window,
      audit,
    };

  const [baseGates, { pairs: versionPairs, countByEntry: qualifyingVersions }] = await Promise.all([
    loadBaseGates(window.ageCutoff),
    loadQualifyingVersions(entries, window, baseModels),
  ]);

  const [imageAuthors, collectors, imageRowsRaw, images] = await Promise.all([
    countImageAuthors(entries, versionPairs, window, baseGates),
    countCollectors(entries, window, baseGates, input.collectionId),
    loadImagePairs(entries, versionPairs, window),
    loadEntryImages(entries.map((e) => e.modelId)),
  ]);

  const truncatedImages = imageRowsRaw.length > MAX_IMAGE_PAIRS;
  const imageRows = truncatedImages ? imageRowsRaw.slice(0, MAX_IMAGE_PAIRS) : imageRowsRaw;
  const imagePairs = toImagePairs(imageRows, entries);

  const chSources = chSignalSources(window);

  const imageIds = intList([...new Set(imagePairs.map((p) => p.entityId))]) || '0';
  const versionIds = intList([...new Set(versionPairs.map((p) => p.entityId))]) || '0';

  // Resolve banned/deleted against the ENGAGERS, not the other way round: the
  // banned-or-deleted population is ~1.35M rows and must never reach ClickHouse.
  const engagers = await collectChEngagers(
    [
      chSources.reactors(imageIds),
      chSources.downloaders(versionIds),
      chSources.generators(versionIds),
    ],
    baseGates
  );

  const bannedRefinementSkipped = engagers.length > config.maxEngagers;
  if (bannedRefinementSkipped)
    console.warn(
      `[contest-score] collection ${input.collectionId} has ${engagers.length} engagers, above the configured ceiling; the banned/deleted refinement was skipped and the run is flagged degraded.`
    );

  const gates: Gates = {
    ...baseGates,
    disqualifiedIds: bannedRefinementSkipped
      ? baseGates.baseDisqualifiedIds
      : [
          ...new Set([
            ...baseGates.baseDisqualifiedIds,
            ...(await resolveBannedEngagers(engagers)),
          ]),
        ].sort((a, b) => a - b),
    bannedRefinementSkipped,
    engagerCount: engagers.length,
  };

  audit.engagerCount = gates.engagerCount;
  audit.ageGateBandUsers = gates.ageGateBandUsers;

  const [reactors, downloaders, generators] = await Promise.all([
    runChCounts('reactors', imagePairs, gates, chSources.reactors),
    runChCounts('downloaders', versionPairs, gates, chSources.downloaders),
    runChCounts('generators', versionPairs, gates, chSources.generators),
  ]);

  const counts = new Map<number, ContestScoreEntry['signals']>(
    entries.map((e) => [e.collectionItemId, emptySignals()])
  );
  const apply = (signal: Signal, rows: SignalCount[]) => {
    for (const row of rows) {
      const bucket = counts.get(Number(row.collectionItemId));
      if (!bucket) continue;
      bucket[signal] = { raw: Number(row.rawUsers), qualified: Number(row.qualifiedUsers) };
    }
  };
  apply('imageAuthors', imageAuthors);
  apply('collectors', collectors);
  apply('reactors', reactors);
  apply('downloaders', downloaders);
  apply('generators', generators);

  const scored = entries.map((entry) => {
    const signals = counts.get(entry.collectionItemId) ?? emptySignals();
    const rawTotal = contestScoreSignals.reduce((sum, s) => sum + signals[s].raw, 0);
    const qualifiedTotal = contestScoreSignals.reduce((sum, s) => sum + signals[s].qualified, 0);
    const qualifyingVersionCount = qualifyingVersions.get(entry.collectionItemId) ?? 0;
    const reason = ineligibilityReason(entry, qualifyingVersionCount, baseModels.length > 0);

    return {
      collectionItemId: entry.collectionItemId,
      qualifyingVersionCount,
      modelId: entry.modelId,
      modelName: entry.modelName,
      creatorId: entry.creatorId,
      creatorUsername: entry.creatorUsername,
      status: entry.status,
      eligible: !reason,
      ineligibleReason: reason,
      tagId: entry.tagId,
      image: images.get(entry.modelId) ?? null,
      signals,
      rawTotal,
      qualifiedTotal,
      // Share of engagement that failed qualification. High = worth staff eyes.
      disqualifiedShare: rawTotal ? +((rawTotal - qualifiedTotal) / rawTotal).toFixed(3) : 0,
    };
  });

  const categories = [...new Set(entries.map((e) => e.tagId))].map(
    (tagId): ContestScoreCategory => {
      const tagName = entries.find((e) => e.tagId === tagId)?.tagName ?? null;
      const items = scored.filter((e) => e.tagId === tagId);
      const eligible = items.filter((i) => i.eligible);
      const missingCount = Math.max((categoryTotals.get(tagId) ?? items.length) - items.length, 0);

      // Normalized against the leading ELIGIBLE entry per signal, so an entry pulled
      // after accruing engagement cannot set the bar for everyone else.
      //
      // Floored at the configured minDenominator: where a category's leading count is
      // tiny, a bare maximum lets one or two users swing a signal from 0 to 0.5 and
      // decide a placement on noise.
      const maxima = Object.fromEntries(
        contestScoreSignals.map((s) => [
          s,
          Math.max(...eligible.map((i) => i.signals[s].qualified), 0, config.minDenominator[s]),
        ])
      ) as Record<Signal, number>;

      const withScores = items.map(({ tagId: _tagId, ...item }) => {
        let total = 0;
        for (const signal of contestScoreSignals) {
          const max = maxima[signal];
          if (max > 0) total += (item.signals[signal].qualified / max) * config.weights[signal];
        }
        return { ...item, score: item.eligible ? +total.toFixed(4) : 0 };
      });

      const tied = withScores.every((item) => item.score === 0);

      // Ranks are withheld wholesale when the category lost entries to the cap: the
      // maxima above are computed from SURVIVORS only, so every score in the category
      // is wrong by an unknown amount and a 1..N ranking over them would look
      // complete while being unsound.
      const rankable = !tied && !missingCount;

      const ordered = withScores.sort(
        (a, b) =>
          Number(b.eligible) - Number(a.eligible) ||
          b.score - a.score ||
          b.qualifiedTotal - a.qualifiedTotal ||
          a.modelId - b.modelId
      );

      // Competition ranking: equal scores take the SAME rank and consume the numbers
      // after it (1, 2, 2, 4). The secondary sort keys above order the rows for
      // display, but they must never break a tie into distinct prizes — deciding a
      // placement by lower model id is arbitrary, and nothing on screen would have
      // said so.
      let lastScore: number | null = null;
      let lastRank = 0;
      const entriesRanked = ordered.map((item, index) => {
        if (!item.eligible || !rankable)
          return { ...item, rank: null, sharedRank: false, belowDisplayPrecision: false };
        const rank = lastScore !== null && item.score === lastScore ? lastRank : index + 1;
        lastScore = item.score;
        lastRank = rank;

        const neighbours = [ordered[index - 1], ordered[index + 1]].filter(
          (n) => n?.eligible && n.score !== item.score
        );
        return {
          ...item,
          rank,
          sharedRank: ordered.some(
            (other) => other !== item && other.eligible && other.score === item.score
          ),
          // Scores are carried at 4dp and rendered at 3dp, so two rows can read
          // identically on screen and still hold different ranks. Flagged rather than
          // hidden: the fix is a judgement call, not a rounding one.
          belowDisplayPrecision: neighbours.some(
            (n) =>
              n!.score.toFixed(SCORE_DISPLAY_PRECISION) ===
              item.score.toFixed(SCORE_DISPLAY_PRECISION)
          ),
        };
      });

      return {
        tagId,
        tagName,
        entryCount: items.length,
        eligibleCount: eligible.length,
        soloEntry: eligible.length === 1,
        tied,
        truncated: missingCount > 0,
        missingCount,
        entries: entriesRanked,
      };
    }
  );

  return {
    score: {
      ...base,
      entryCount: entries.length,
      truncated: { entries: truncated, images: truncatedImages },
      degraded: { bannedRefinementSkipped },
      categories,
    },
    config,
    scope,
    window,
    audit,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const runNamespace = (collectionId: number) =>
  `${REDIS_KEYS.CACHES.CONTEST_SCORE_RUN}:${collectionId}`;
const runStateKey = (collectionId: number, runId: string) =>
  `${runNamespace(collectionId)}:run:${runId}` as RedisKeyTemplateCache;
const latestRunKey = (collectionId: number) =>
  `${runNamespace(collectionId)}:latest` as RedisKeyTemplateCache;

/**
 * A run's identity: the window, the filters, and the exact config and code that
 * produced it. A config edit bumps `version`, so the previous result becomes
 * unreachable at its old key and expires on its own rather than being served as if
 * the new weights had produced it.
 */
function resultKeyFor(
  input: WindowInput,
  config: ContestScoringConfig,
  scope: ContestScoringScope
) {
  return `${runNamespace(input.collectionId)}:result:${hashifyObject({
    start: input.start?.toISOString(),
    end: input.end?.toISOString(),
    tagIds: input.tagIds,
    statuses: input.statuses,
    configScope: scope,
    configVersion: config.version,
    codeVersion: CONTEST_SCORE_CODE_VERSION,
  })}` as RedisKeyTemplateCache;
}

async function clearLatestRun(collectionId: number) {
  await redis.del(latestRunKey(collectionId)).catch(() => null);
}

/**
 * Run state is Redis-only and every key carries a TTL, so the namespace self-cleans
 * and an abandoned run cannot outlive its usefulness. The signal is best-effort: the
 * state in Redis is the truth, and the read query returns it, so a dropped push
 * costs a refresh rather than a stuck UI.
 */
async function writeRunState(state: ContestScoreRunState) {
  const current = await redis.packed
    .get<ContestScoreRunState>(latestRunKey(state.collectionId))
    .catch(() => null);

  // The pointer is last-write-wins, and two runs can be in flight across pods (the
  // lock serializes the COMPUTE, not the enqueue). Without this an older run's
  // terminal write lands after a newer run's `running` and walks the banner backwards.
  const stale =
    !!current && current.runId !== state.runId && current.requestedAt > state.requestedAt;

  await Promise.all([
    redis.packed.set(runStateKey(state.collectionId, state.runId), state, { EX: RUN_STATE_TTL }),
    stale
      ? Promise.resolve()
      : redis.packed.set(latestRunKey(state.collectionId), state, { EX: RUN_STATE_TTL }),
  ]);
}

async function publishRunState(state: ContestScoreRunState) {
  await writeRunState(state);

  signalClient
    .topicSend({
      topic: `${SignalTopic.ContestScore}:${state.collectionId}`,
      target: SignalMessages.ContestScoreRunUpdate,
      // Run bookkeeping only. A topic is joinable by any connected client, so no
      // score and no config value may ride on this payload.
      data: state,
    })
    .catch((error: Error) =>
      console.error('[contest-score] failed to signal run state', state.runId, error?.message)
    );
}

/**
 * A run whose pod died mid-compute leaves `running` behind with nothing to clear it,
 * and the UI disables its Run button for as long as the state survives. The heartbeat
 * is what distinguishes a long run from a dead one; a state that stopped beating is
 * reported as failed so a moderator can start another.
 */
function reconcileStaleRun(state: ContestScoreRunState | null) {
  if (!state || (state.status !== 'running' && state.status !== 'queued')) return state;

  const beat = new Date(state.heartbeatAt ?? state.startedAt ?? state.requestedAt).getTime();
  if (Date.now() - beat < RUN_STALE_AFTER * 1000) return state;

  return {
    ...state,
    status: 'failed' as const,
    finishedAt: new Date().toISOString(),
    error: 'The run stopped reporting progress and was abandoned. Start another.',
  };
}

async function readRunState(collectionId: number) {
  const stored = await redis.packed.get<ContestScoreRunState>(latestRunKey(collectionId));
  return reconcileStaleRun(stored ?? null);
}

async function executeRun(input: WindowInput, state: ContestScoreRunState) {
  const startedAt = new Date().toISOString();
  let running: ContestScoreRunState = {
    ...state,
    status: 'running',
    startedAt,
    heartbeatAt: startedAt,
  };
  await publishRunState(running);

  // Redis-only, and deliberately not signalled: the beat is liveness, not news.
  const heartbeat = setInterval(() => {
    running = { ...running, heartbeatAt: new Date().toISOString() };
    writeRunState(running).catch(() => null);
  }, RUN_HEARTBEAT_INTERVAL * 1000);

  try {
    // One run per collection at a time. Nothing is waiting on the response now, so
    // the loser of the race waits for the lock rather than failing the caller.
    const outcome = await withDistributedLock(
      {
        key: `contest-score:${input.collectionId}`,
        ttl: RUN_LOCK_TTL,
        retryDelay: 500,
        maxRetries: 240,
        autoRenew: true,
      },
      () => computeCommunityScore(input)
    );
    if (!outcome)
      throw new ContestScoringError(
        'A scoring run for this collection is already in progress. Try again shortly.'
      );

    // Keyed off the config the run ACTUALLY used, not a second resolution taken
    // before the lock — a config saved while this waited would otherwise strand the
    // result under a key no reader will look at.
    await redis.packed.set(resultKeyFor(input, outcome.config, outcome.scope), outcome.score, {
      EX: RESULT_TTL,
    });
    await publishRunState({
      ...running,
      status: 'done',
      finishedAt: new Date().toISOString(),
      generatedAt: outcome.score.generatedAt,
    });
  } catch (e) {
    await publishRunState({
      ...running,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: safeErrorMessage(input.collectionId, e),
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Enqueues a run and returns immediately. The compute is detached on purpose: a full
 * cross-store aggregation outlives a request timeout on a large contest, and the run
 * state in Redis — not the HTTP response — is what the UI follows.
 */
export async function runCommunityScore({
  input,
  userId,
}: {
  input: RunCommunityScoreInput;
  userId: number;
}): Promise<ContestScoreRunState> {
  try {
    // Resolved before enqueueing so a misconfiguration or a non-contest collection
    // fails the mutation rather than surfacing minutes later as a failed run.
    requireClickhouse();
    const { config } = await resolveContestScoringConfig(input.collectionId);
    await resolveWindow(input.collectionId, input, config);

    const state: ContestScoreRunState = {
      runId: uuid(),
      collectionId: input.collectionId,
      status: 'queued',
      requestedBy: userId,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      generatedAt: null,
    };
    await publishRunState(state);

    void executeRun(input, state).catch((error: Error) =>
      console.error('[contest-score] run crashed', state.runId, error?.message)
    );

    return state;
  } catch (e) {
    return sanitizeError(input.collectionId, e);
  }
}

/**
 * Read-only. Returns whatever the last completed run produced for this window plus
 * the current run state; it never computes. The client keeps the previous result on
 * screen while a run is in flight, so a run starting must not blank the table.
 */
export async function getCommunityScore(input: GetCommunityScoreInput) {
  try {
    const { config, scope } = await resolveContestScoringConfig(input.collectionId);
    const [result, run] = await Promise.all([
      redis.packed.get<ContestCommunityScore>(resultKeyFor(input, config, scope)),
      readRunState(input.collectionId),
    ]);

    return { result: result ?? null, run };
  } catch (e) {
    return sanitizeError(input.collectionId, e);
  }
}

/**
 * Engagers on this contest worth a look: accounts acting from IPs shared by many
 * contest engagers, or whose contest engagement concentrates on a single creator.
 * Evidence only — never an automatic disqualification.
 *
 * Unlike the scoring path this legitimately returns user ids — that IS the report —
 * so it aggregates per (user, creator) in ClickHouse and merges in Node. The
 * intermediate is bounded by the engager ceiling, and the response by `limit`.
 * Farm-IP peer counts have to be global, so they are built from the merged set
 * rather than per chunk, where they would undercount.
 */
export async function getContestCandidates(input: GetContestCandidatesInput) {
  try {
    requireClickhouse();
    const config = await getContestScoringConfig(input.collectionId);
    const window = await resolveWindow(input.collectionId, input, config);
    const limit = input.limit ?? 200;

    const { entries } = await loadEntries(input);
    if (!entries.length) return { collectionId: input.collectionId, count: 0, candidates: [] };

    const baseGates = await loadBaseGates(window.ageCutoff);
    const { pairs: versionPairs } = await loadQualifyingVersions(
      entries,
      window,
      resolveBaseModels(window, config).baseModels
    );
    const imagePairs = toImagePairs(await loadImagePairs(entries, versionPairs, window), entries);

    // Reactions and downloads are the engagement events that carry an IP — the same
    // farm-IP signal `reaction-abuse` uses, scoped to this contest.
    const candidateSources = chCandidateSources(window);
    const perCreator = (
      await Promise.all([
        runChPerCreator('candidates.downloads', versionPairs, candidateSources.downloads),
        runChPerCreator('candidates.reactions', imagePairs, candidateSources.reactions),
      ])
    ).flat();

    const usersPerIp = new Map<string, Set<number>>();
    for (const row of perCreator)
      for (const ip of row.ips) {
        if (!ip) continue;
        if (!usersPerIp.has(ip)) usersPerIp.set(ip, new Set());
        usersPerIp.get(ip)!.add(row.userId);
      }
    const farmIps = new Set(
      [...usersPerIp.entries()]
        .filter(([, users]) => users.size >= config.farmIp.minPeers)
        .map(([ip]) => ip)
    );

    type Candidate = {
      events: number;
      entriesTouched: number;
      creators: Map<number, number>;
      farmIps: Set<string>;
    };
    const byUser = new Map<number, Candidate>();
    for (const row of perCreator) {
      let candidate = byUser.get(row.userId);
      if (!candidate) {
        candidate = { events: 0, entriesTouched: 0, creators: new Map(), farmIps: new Set() };
        byUser.set(row.userId, candidate);
      }
      candidate.events += row.events;
      candidate.entriesTouched += row.entries;
      candidate.creators.set(
        row.creatorId,
        (candidate.creators.get(row.creatorId) ?? 0) + row.events
      );
      for (const ip of row.ips) if (farmIps.has(ip)) candidate.farmIps.add(ip);
    }

    const rows = [...byUser.entries()]
      .map(([userId, candidate]) => {
        const [topCreator, toTopCreator] = [...candidate.creators.entries()].sort(
          (a, b) => b[1] - a[1]
        )[0] ?? [0, 0];
        return {
          userId,
          events: candidate.events,
          entriesTouched: candidate.entriesTouched,
          distinctCreators: candidate.creators.size,
          topCreator,
          toTopCreator,
          topCreatorConcentration: +(toTopCreator / candidate.events).toFixed(2),
          farmIpsUsed: candidate.farmIps.size,
          // Reported so a reviewer can tell a too-young account from an excluded one
          // without re-deriving the threshold themselves.
          newAccount: userId > baseGates.userIdThreshold,
        };
      })
      .filter(
        (row) =>
          row.farmIpsUsed > 0 ||
          (row.entriesTouched >= config.farmIp.minEntries && row.distinctCreators === 1)
      )
      // Concentration on one creator is the discriminating signal; farm IPs alone
      // catch shared/CGNAT addresses too, so they only break ties.
      .sort(
        (a, b) =>
          b.topCreatorConcentration - a.topCreatorConcentration ||
          b.farmIpsUsed - a.farmIpsUsed ||
          b.events - a.events
      )
      .slice(0, limit);

    return { collectionId: input.collectionId, count: rows.length, candidates: rows };
  } catch (e) {
    return sanitizeError(input.collectionId, e);
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Which deployment produced a snapshot, derived from the ENVIRONMENT and never from
 * mutation input — an operator cannot forget it and a client cannot spoof it.
 * Preview namespaces carry these vars; production carries none of them.
 */
function snapshotSource() {
  if (process.env.IS_PREVIEW !== 'true' && process.env.NEXT_PUBLIC_IS_PR_PREVIEW !== 'true')
    return null;
  const pr = process.env.NEXT_PUBLIC_PR_NUMBER;
  return pr ? `preview-${pr}` : 'preview';
}

/**
 * The artifact that defends a disputed prize, so it stores the RESOLVED config —
 * weights included — alongside the window, the age cutoff and the code version.
 * Weights are stripped on the wire, never in storage. No userIds are ever stored.
 *
 * The source marker is in the KEY as well as the value so preview rows are a prefix
 * delete rather than a deserialize-and-filter:
 *   contestSnapshot:<collectionId>:preview-<pr>:<ISO>
 *   contestSnapshot:<collectionId>:<ISO>
 *
 * KeyValue keeps this migration-free for v1. A dedicated table (indexed by
 * collection, payload out of a jsonb column) is the follow-up once the shape
 * settles.
 */
export type ContestSnapshot = {
  collectionId: number;
  takenAt: string;
  takenById: number;
  takenByUsername: string | null;
  source: string | null;
  note?: string;
  codeVersion: number;
  config: ContestScoringConfig;
  /** Which row the config came from, so a later reader need not guess. */
  configScope: ContestScoringScope;
  ageCutoff: string;
  /**
   * Diagnostic only. The threshold is cached for a week, so this can be up to that
   * stale — it is NOT a measurement taken at snapshot time.
   */
  ageGateBandUsers: number;
  engagerCount: number;
  /** Empty means no base-model filter was applied, not that the field was forgotten. */
  baseModels: string[];
  /** `collection` metadata, the scoring `config` row, or `none`. */
  baseModelSource: ResolvedBaseModels['source'];
  partial: boolean;
  score: ContestCommunityScore;
};

/**
 * The READ shape, and deliberately weaker than the write shape above. A stored row is
 * whatever the code that wrote it produced, and it is cast through unvalidated — so
 * every field added after the first snapshot is optional here.
 *
 * `ContestSnapshot` describes what we WRITE today; this describes what we may FIND.
 * Conflating the two is what let a missing field be dereferenced and take down the
 * whole results panel. A field added later must not typecheck as present on a row
 * written before it existed.
 */
export type StoredContestSnapshot = Omit<
  ContestSnapshot,
  'codeVersion' | 'baseModels' | 'baseModelSource'
> & {
  codeVersion?: number;
  baseModels?: string[];
  baseModelSource?: ResolvedBaseModels['source'];
};

export type ContestSnapshotSummary = Omit<StoredContestSnapshot, 'config' | 'score'> & {
  key: string;
  window: ContestCommunityScore['window'];
  entryCount: number;
};

const snapshotKey = (collectionId: number, takenAt: string, source: string | null) =>
  [CONTEST_SNAPSHOT_KEY_PREFIX, collectionId, ...(source ? [source] : []), takenAt].join(':');

function toSnapshotSummary(key: string, snapshot: StoredContestSnapshot): ContestSnapshotSummary {
  // `config` — and therefore the weights — is dropped here. It is stored for audit,
  // never served.
  const { config: _config, score, ...rest } = snapshot;
  return { key, ...rest, window: score.window, entryCount: score.entryCount };
}

export async function createContestSnapshot({
  input,
  userId,
  username,
}: {
  input: CreateContestSnapshotInput;
  userId: number;
  username?: string | null;
}): Promise<ContestSnapshotSummary> {
  const { note, ...window } = input;
  try {
    // Through the same lock the scoring path uses, and with the same TTL: at 120s a
    // snapshot silently lost the lock partway through its own run and a concurrent
    // run stacked the second aggregation this exists to prevent.
    const outcome = await withDistributedLock(
      {
        key: `contest-score:${window.collectionId}`,
        ttl: RUN_LOCK_TTL,
        retryDelay: 500,
        maxRetries: 240,
        autoRenew: true,
      },
      () => computeCommunityScore(window)
    );
    if (!outcome)
      throw new ContestScoringError(
        'A scoring run for this collection is already in progress. Try again shortly.'
      );

    const takenAt = new Date().toISOString();
    const source = snapshotSource();
    const key = snapshotKey(window.collectionId, takenAt, source);
    // Every field here comes from the run that produced `score`, never from a second
    // resolution taken around it. A config saved while this waited on the lock would
    // otherwise leave a permanent record attesting to weights that never produced its
    // ranking — in the one row we would use to defend a disputed prize.
    const snapshot: ContestSnapshot = {
      collectionId: window.collectionId,
      takenAt,
      takenById: userId,
      takenByUsername: username ?? null,
      source,
      ...(note ? { note } : {}),
      codeVersion: CONTEST_SCORE_CODE_VERSION,
      config: outcome.config,
      configScope: outcome.scope,
      ageCutoff: outcome.window.ageCutoff.toISOString(),
      ageGateBandUsers: outcome.audit.ageGateBandUsers,
      engagerCount: outcome.audit.engagerCount,
      baseModels: outcome.audit.baseModels,
      baseModelSource: outcome.audit.baseModelSource,
      partial: outcome.window.partial,
      score: outcome.score,
    };

    try {
      await dbWrite.keyValue.create({
        data: { key, value: snapshot as unknown as Prisma.InputJsonValue },
      });
    } catch (e) {
      // Never an upsert: overwriting a judging artifact silently is worse than
      // failing. Only the message is softened.
      if ((e as { code?: string }).code === 'P2002')
        throw new ContestScoringError('A snapshot for this instant already exists.');
      throw e;
    }

    return toSnapshotSummary(key, snapshot);
  } catch (e) {
    return sanitizeError(window.collectionId, e);
  }
}

export type ContestSnapshotRef = {
  key: string;
  source: string | null;
  takenAt: string;
  partial: boolean;
};

/**
 * The key carries everything the list needs, so `takenAt` and the source marker are
 * read back off it: `<prefix>:<collectionId>:[source:]<ISO>`. The ISO timestamp
 * contains colons of its own, hence the leading-year test rather than a field count.
 */
function parseSnapshotKey(
  collectionId: number,
  key: string
): Omit<ContestSnapshotRef, 'partial'> | null {
  const prefix = `${CONTEST_SNAPSHOT_KEY_PREFIX}:${collectionId}:`;
  if (!key.startsWith(prefix)) return null;

  const rest = key.slice(prefix.length);
  if (/^\d{4}-/.test(rest)) return { key, source: null, takenAt: rest };

  const split = rest.indexOf(':');
  if (split < 0) return null;
  return { key, source: rest.slice(0, split), takenAt: rest.slice(split + 1) };
}

/**
 * The key plus one jsonb field. `takenAt` and the source marker come off the key;
 * `partial` is extracted IN Postgres rather than by shipping the row — a snapshot
 * embeds a full scored payload, and deserializing the set to render a list of dates
 * would grow with entries × snapshots for a list that shows neither.
 *
 * `partial` earns the exception: without it a mid-contest snapshot is
 * indistinguishable from a final one in the list, which is the most damaging thing
 * this screen can get wrong.
 */
export async function listContestSnapshots({ collectionId }: { collectionId: number }) {
  try {
    const rows = await dbRead.$queryRaw<{ key: string; partial: boolean | null }[]>`
      SELECT kv."key" AS "key", (kv."value" ->> 'partial')::boolean AS "partial"
      FROM "KeyValue" kv
      WHERE kv."key" LIKE ${`${CONTEST_SNAPSHOT_KEY_PREFIX}:${collectionId}:%`}
    `;

    return rows
      .map((row) => {
        const ref = parseSnapshotKey(collectionId, row.key);
        return ref ? { ...ref, partial: row.partial ?? false } : null;
      })
      .filter((ref): ref is ContestSnapshotRef => !!ref)
      .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  } catch (e) {
    return sanitizeError(collectionId, e);
  }
}

export async function getContestSnapshot({
  collectionId,
  key,
}: {
  collectionId: number;
  key: string;
}) {
  try {
    // The key is client-supplied, so it is re-derived against this collection's
    // prefix before it reaches the query — a KeyValue lookup by arbitrary key would
    // read any row in the table, config and audit rows included.
    if (!parseSnapshotKey(collectionId, key))
      throw new ContestScoringError('That snapshot does not belong to this collection.');

    const row = await dbRead.keyValue.findUnique({ where: { key }, select: { value: true } });
    if (!row) throw new ContestScoringError('Snapshot not found.');

    const snapshot = row.value as unknown as StoredContestSnapshot;
    // `config` — and therefore the weights — is dropped by toSnapshotSummary. It is
    // stored for audit, never served.
    return { ...toSnapshotSummary(key, snapshot), score: snapshot.score };
  } catch (e) {
    return sanitizeError(collectionId, e);
  }
}
