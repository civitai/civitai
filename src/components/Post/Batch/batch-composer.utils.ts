import type { Rng, ScheduleGeneration } from '@civitai/shared/post-scheduling';
import {
  addMinutes,
  applyJitter,
  generateEverySchedule,
  generateSpreadSchedule,
  POST_BATCH_CHUNK_MAX_IMAGES,
  POST_BATCH_CHUNK_POSTS,
  POST_BATCH_MIN_GAP_MINUTES,
  POST_MINIMUM_SCHEDULE_MINUTES,
  seededRng,
  utcDayKey,
} from '@civitai/shared/post-scheduling';
import * as z from 'zod';
import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { NsfwLevel } from '~/server/common/enums';
import {
  browsingLevelLabels,
  getHighestBrowsingLevelBit,
} from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import type { SharedSettings } from './batch-composer.store';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type TitleTokens = {
  n: number;
  total: number;
  model?: string | null;
  version?: string | null;
  date: Date;
};

export const TITLE_TOKENS = ['{n}', '{total}', '{model}', '{version}', '{date}'] as const;

/** Expands `{n}`, `{total}`, `{model}`, `{version}` and `{date}`; unknown tokens stay as typed. */
export function expandTitleTemplate(template: string, tokens: TitleTokens): string {
  return template
    .replace(/\{n\}/g, String(tokens.n))
    .replace(/\{total\}/g, String(tokens.total))
    .replace(/\{model\}/g, tokens.model ?? '')
    .replace(/\{version\}/g, tokens.version ?? '')
    .replace(/\{date\}/g, formatDate(tokens.date, 'MMM D, YYYY'))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function defaultTitleTemplate(hasModel: boolean): string {
  return hasModel ? '{model} — {n}' : '';
}

export type PromotedVersion = { id: number; model: string; version: string };

/** The `{model}` / `{version}` names of a version picked in the composer's resource modal. */
export function promotedFromResource(resource: {
  id: number;
  name: string;
  model: { name: string };
}): PromotedVersion {
  return { id: resource.id, model: resource.model.name, version: resource.name };
}

export function groupIntoPosts<T>(items: T[], perPost: number): T[][] {
  const size = Math.max(1, Math.floor(perPost));
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

const PROGRESS_STEPS = 8;

/** Posts per call: small enough that the progress bar moves at least ~8 times, never over the
 *  server's per-call cap. */
export function chunkSizeFor(total: number): number {
  return Math.min(POST_BATCH_CHUNK_POSTS, Math.max(1, Math.ceil(total / PROGRESS_STEPS)));
}

/** Splits posts into the sequential `scheduleBatch` calls: at most `maxPosts` posts and
 *  `maxImages` images per call, in order. */
export function chunkPosts<T extends { images: unknown[] }>(
  posts: T[],
  limits: { maxPosts?: number; maxImages?: number } = {}
): T[][] {
  const { maxPosts = POST_BATCH_CHUNK_POSTS, maxImages = POST_BATCH_CHUNK_MAX_IMAGES } = limits;
  const chunks: T[][] = [];
  let current: T[] = [];
  let images = 0;
  for (const post of posts) {
    const overflow =
      current.length >= maxPosts || (current.length > 0 && images + post.images.length > maxImages);
    if (overflow) {
      chunks.push(current);
      current = [];
      images = 0;
    }
    current.push(post);
    images += post.images.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export { shuffle } from '@civitai/shared/post-scheduling';

export type EveryUnit = 'minutes' | 'hours' | 'days';
export const EVERY_UNIT_MINUTES: Record<EveryUnit, number> = { minutes: 1, hours: 60, days: 1440 };

export type ScheduleMode = 'every' | 'spread';
export type ScheduleSettings = {
  mode: ScheduleMode;
  start: Date;
  every: number;
  unit: EveryUnit;
  from: Date;
  to: Date;
};

const DEFAULT_LEAD_MINUTES = 20;
const START_STEP_MINUTES = 15;

/** The next quarter hour at least 20 minutes out, seconds cleared. */
export function defaultScheduleStart(now: Date): Date {
  const earliest = addMinutes(now, DEFAULT_LEAD_MINUTES);
  earliest.setSeconds(0, 0);
  const remainder = earliest.getMinutes() % START_STEP_MINUTES;
  return remainder === 0 ? earliest : addMinutes(earliest, START_STEP_MINUTES - remainder);
}

/** `startAt` is the day a planner's quick-add was clicked on; anything inside the lead is ignored. */
export function defaultScheduleSettings(now: Date, startAt?: Date | null): ScheduleSettings {
  const earliest = defaultScheduleStart(now);
  const start = startAt && startAt > earliest ? startAt : earliest;
  return {
    mode: 'every',
    start,
    every: 4,
    unit: 'hours',
    from: start,
    to: new Date(start.getTime() + 30 * DAY_MS),
  };
}

export function everyMinutesOf(settings: Pick<ScheduleSettings, 'every' | 'unit'>): number {
  return settings.every * EVERY_UNIT_MINUTES[settings.unit];
}

export function generateBatchDates(
  settings: ScheduleSettings,
  count: number,
  seed: number
): ScheduleGeneration {
  const rng = seededRng(seed);
  if (settings.mode === 'every')
    return generateEverySchedule({
      start: settings.start,
      everyMinutes: everyMinutesOf(settings),
      count,
      rng,
    });
  return generateSpreadSchedule({ from: settings.from, to: settings.to, count, rng });
}

export function describeCadence(settings: ScheduleSettings, dates: Date[]): string {
  if (!dates.length) return '';
  const perDay = postsPerDay(dates);
  if (settings.mode === 'every') {
    const unit = settings.unit === 'hours' ? 'h' : settings.unit === 'days' ? 'd' : 'min';
    return `Every ${settings.every}${unit} · ~${perDay}/day`;
  }
  const days = Math.max(1, Math.round((settings.to.getTime() - settings.from.getTime()) / DAY_MS));
  return `Spread over ${days} day${days === 1 ? '' : 's'} · ~${perDay}/day`;
}

function postsPerDay(dates: Date[]): number {
  const days = new Set(dates.map(utcDayKey)).size;
  return Math.max(1, Math.round(dates.length / Math.max(1, days)));
}

/**
 * Pushes posts later (never earlier) until each one keeps the gap from every other post and no
 * UTC day exceeds the cap. Returns the dates in their original order.
 */
export function fixSpacing(input: {
  dates: Date[];
  existing: Date[];
  dailyLimit: number;
  now: Date;
  minGapMinutes?: number;
  minLeadMinutes?: number;
  rng?: Rng;
}): { dates: Date[]; moved: number } {
  const {
    dates,
    existing,
    dailyLimit,
    now,
    minGapMinutes = POST_BATCH_MIN_GAP_MINUTES,
    minLeadMinutes = POST_MINIMUM_SCHEDULE_MINUTES,
    rng = Math.random,
  } = input;
  const gapMs = minGapMinutes * MINUTE_MS;
  const earliest = addMinutes(now, minLeadMinutes).getTime();
  const sortedExisting = [...existing].sort((a, b) => a.getTime() - b.getTime());
  const perDay = new Map<string, number>();
  for (const date of sortedExisting) {
    const day = utcDayKey(date);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const order = dates
    .map((date, index) => ({ date, index }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const result: Date[] = new Array(dates.length);
  let lastPlaced: number | null = null;
  let moved = 0;

  for (const { date, index } of order) {
    let candidate = Math.max(
      date.getTime(),
      earliest,
      lastPlaced === null ? 0 : lastPlaced + gapMs
    );
    for (let guard = 0; guard < 10_000; guard++) {
      const clash = sortedExisting.find((other) => Math.abs(other.getTime() - candidate) < gapMs);
      if (clash) {
        candidate = clash.getTime() + gapMs;
        continue;
      }
      const asDate = new Date(candidate);
      if (asDate.getUTCMinutes() === 0) {
        candidate += MINUTE_MS;
        continue;
      }
      const day = utcDayKey(asDate);
      if ((perDay.get(day) ?? 0) >= dailyLimit) {
        const nextMidnight = Date.UTC(
          asDate.getUTCFullYear(),
          asDate.getUTCMonth(),
          asDate.getUTCDate() + 1
        );
        candidate = applyJitter(new Date(nextMidnight), rng).getTime();
        continue;
      }
      break;
    }
    const placed = new Date(candidate);
    placed.setUTCSeconds(0, 0);
    const day = utcDayKey(placed);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (placed.getTime() !== date.getTime()) moved++;
    result[index] = placed;
    lastPlaced = placed.getTime();
  }
  return { dates: result, moved };
}

/** What `post.getBatchMediaStatus` reports for a persisted draft row. */
export type BatchScanStatus = {
  ingestion: ImageIngestionStatus;
  nsfwLevel: number;
  blockedFor: string | null;
  needsReview: string | null;
  minor: boolean;
  poi: boolean;
};

/** A grid entry: the upload result, the draft row `persistBatchMedia` made for it, and its scan. */
export type BatchMedia = MediaUploadOnCompleteProps &
  Partial<BatchScanStatus> & {
    imageId?: number;
    /** The upload finished but `persistBatchMedia` failed; retry re-persists the same key. */
    persistFailed?: boolean;
  };

export type UploadedMedia = BatchMedia & { status: 'added' };
export type PostableMedia = UploadedMedia & { imageId: number };

export function isBlockedMedia(media: BatchMedia): boolean {
  return media.status === 'blocked' || media.ingestion === ImageIngestionStatus.Blocked;
}

export function isFailedMedia(media: BatchMedia): boolean {
  return media.status === 'error' || !!media.persistFailed;
}

/** Uploaded, with its `persistBatchMedia` call still to answer. */
export function isPersistingMedia(media: BatchMedia): boolean {
  return media.status === 'added' && media.imageId === undefined && !media.persistFailed;
}

/** Persisted and not rated yet. */
export function isScanningMedia(media: BatchMedia): boolean {
  return (
    media.status === 'added' &&
    media.imageId !== undefined &&
    (media.ingestion === undefined || media.ingestion === ImageIngestionStatus.Pending)
  );
}

/** An image a post can be made of: persisted and not blocked. A pending or failed scan is fine,
 *  as the editor publishes those too. */
export function isPostable(media: BatchMedia): media is PostableMedia {
  return (
    media.status === 'added' &&
    media.imageId !== undefined &&
    !media.persistFailed &&
    !isBlockedMedia(media)
  );
}

const SCAN_POLL_FAST_MS = 5_000;
const SCAN_POLL_SLOW_MS = 15_000;
const SCAN_POLL_SLOW_AFTER_MS = 3 * MINUTE_MS;

/** How often to ask for scan results: every 5 s at first, 15 s once a scan has been pending for
 *  three minutes, and not at all when nothing is pending. */
export function scanPollInterval(input: {
  pending: boolean;
  pendingSince: number | null;
  now: number;
}): number | false {
  if (!input.pending) return false;
  const waited = input.pendingSince === null ? 0 : input.now - input.pendingSince;
  return waited >= SCAN_POLL_SLOW_AFTER_MS ? SCAN_POLL_SLOW_MS : SCAN_POLL_FAST_MS;
}

const LEVEL_ORDER: NsfwLevel[] = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
];

/** "12 PG · 3 PG-13 · 1 R" over the rated, postable media; empty when none is rated yet. */
export function describeLevelCounts(media: BatchMedia[]): string {
  const counts = new Map<NsfwLevel, number>();
  for (const item of media) {
    if (!isPostable(item) || !item.nsfwLevel) continue;
    const level = getHighestBrowsingLevelBit(item.nsfwLevel);
    if (!level) continue;
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  return LEVEL_ORDER.filter((level) => counts.has(level))
    .map((level) => `${counts.get(level)} ${browsingLevelLabels[level]}`)
    .join(' · ');
}

export type PlannedPost = {
  key: string;
  title: string | null;
  publishedAt: Date;
  media: PostableMedia[];
};

export function buildPlan(input: {
  media: PostableMedia[];
  imagesPerPost: number;
  dates: Date[];
  titleTemplate: string;
  model?: string | null;
  version?: string | null;
}): PlannedPost[] {
  const groups = groupIntoPosts(input.media, input.imagesPerPost);
  return groups.map((media, index) => {
    const publishedAt = input.dates[index] ?? input.dates[input.dates.length - 1] ?? new Date(NaN);
    const title = expandTitleTemplate(input.titleTemplate, {
      n: index + 1,
      total: groups.length,
      model: input.model,
      version: input.version,
      date: publishedAt,
    });
    return { key: media[0].url, title: title || null, publishedAt, media };
  });
}

/** One `persistBatchMedia` image: the upload result reshaped to `addPostImageSchema` minus the
 *  post fields. */
export function toPersistImage(media: UploadedMedia) {
  const { width, height, hash } = media.metadata as {
    width?: number;
    height?: number;
    hash?: string;
  };
  const meta = media.meta as Record<string, unknown> | undefined;
  return {
    name: media.name,
    url: media.url,
    hash,
    height,
    width,
    mimeType: media.mimeType,
    meta: meta && Object.keys(meta).length ? meta : undefined,
    type: media.type,
    metadata: media.metadata,
    generationWorkflowId: media.generationWorkflowId,
  };
}

/** One `scheduleBatch` image: the draft row to adopt. */
export function toBatchImage(media: PostableMedia): { imageId: number } {
  return { imageId: media.imageId };
}

/** The per-creator schedule lock is held, by an earlier attempt that is still running. */
export function isScheduleBusy(message: string): boolean {
  return /another scheduling request is still running/i.test(message);
}

/** The copy-deck wording for a `scheduleBatch` refusal; anything unrecognised is shown as sent.
 *  `createdCount` is how many posts earlier calls of this batch already created. */
export function describeServerError(message: string, createdCount = 0): string {
  const day = message.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const outcome = createdCount
    ? `${createdCount} ${createdCount === 1 ? 'post was' : 'posts were'} created before this.`
    : 'Nothing was created.';
  if (/daily limit/i.test(message))
    return `Your schedule hit the daily limit${
      day ? ` on ${day}` : ''
    }. ${outcome} Adjust and try again.`;
  if (/too close|minutes between them|minutes from post/i.test(message))
    return `Two posts would be too close together${day ? ` on ${day}` : ''}. ${outcome}`;
  if (/minutes from now|months out/i.test(message))
    return `Some dates fell outside the ${POST_MINIMUM_SCHEDULE_MINUTES}-minute to 3-month window. ${outcome}`;
  return message;
}

export type ComposerDraft = {
  media: UploadedMedia[];
  imagesPerPost: number;
  shared: SharedSettings;
  presetId: number | null;
  promotedNames: { model: string; version: string } | null;
  schedule: ScheduleSettings;
  seed: number;
  fixedDates: Date[] | null;
};

const draftMediaSchema = z
  .object({
    status: z.literal('added'),
    url: z.string().min(1),
    index: z.number(),
    name: z.string(),
    mimeType: z.string(),
    type: z.enum(['image', 'video']),
    metadata: z.record(z.string(), z.unknown()),
    meta: z.record(z.string(), z.unknown()).optional(),
    generationWorkflowId: z.string().optional(),
    imageId: z.number().int().positive(),
    ingestion: z.enum(ImageIngestionStatus).optional(),
    nsfwLevel: z.number().optional(),
    blockedFor: z.string().nullable().optional(),
    needsReview: z.string().nullable().optional(),
    minor: z.boolean().optional(),
    poi: z.boolean().optional(),
  })
  .passthrough();

const namedOptionSchema = z.object({ id: z.number(), name: z.string() });

const serializedDraftSchema = z.object({
  version: z.literal(1),
  media: z.array(draftMediaSchema),
  imagesPerPost: z.number(),
  shared: z.object({
    promotedVersionId: z.number().nullable(),
    resources: z.array(z.object({ id: z.number() }).passthrough()),
    tools: z.array(namedOptionSchema),
    techniques: z.array(namedOptionSchema),
    tags: z.array(z.string()),
    titleTemplate: z.string(),
  }),
  presetId: z.number().nullable(),
  promotedNames: z.object({ model: z.string(), version: z.string() }).nullable(),
  schedule: z.object({
    mode: z.enum(['every', 'spread']),
    start: z.iso.datetime(),
    every: z.number(),
    unit: z.enum(['minutes', 'hours', 'days']),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  seed: z.number(),
  fixedDates: z.array(z.iso.datetime()).nullable(),
});

export type SerializedDraft = z.infer<typeof serializedDraftSchema>;

/** JSON-safe form of the draft; only persisted uploads are kept: a failed or blocked file's `url`
 *  is a blob URL that dies with the page, and an upload with no row has nothing to reconcile
 *  against on the next visit. */
export function serializeDraft(draft: ComposerDraft): SerializedDraft {
  return {
    version: 1,
    media: draft.media
      .filter((item) => item.status === 'added' && item.imageId !== undefined)
      .map(
        ({ objectUrl: _objectUrl, persistFailed: _persistFailed, ...item }) =>
          item as SerializedDraft['media'][number]
      ),
    imagesPerPost: draft.imagesPerPost,
    shared: draft.shared,
    presetId: draft.presetId,
    promotedNames: draft.promotedNames,
    schedule: {
      ...draft.schedule,
      start: draft.schedule.start.toISOString(),
      from: draft.schedule.from.toISOString(),
      to: draft.schedule.to.toISOString(),
    },
    seed: draft.seed,
    fixedDates: draft.fixedDates?.map((date) => date.toISOString()) ?? null,
  };
}

/** Anything unreadable is dropped rather than repaired; a schedule that has already started goes
 *  back to the defaults so the composer never reopens on dates in the past. */
export function parseDraft(raw: unknown, now: Date): ComposerDraft | null {
  const parsed = serializedDraftSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { data } = parsed;
  const schedule: ScheduleSettings = {
    ...data.schedule,
    start: new Date(data.schedule.start),
    from: new Date(data.schedule.from),
    to: new Date(data.schedule.to),
  };
  const earliest = defaultScheduleStart(now);
  const stale = schedule.mode === 'every' ? schedule.start < earliest : schedule.from < earliest;
  const fixedDates = data.fixedDates?.map((date) => new Date(date)) ?? null;
  return {
    media: data.media.map((item) => ({ ...item, objectUrl: '' } as unknown as UploadedMedia)),
    imagesPerPost: data.imagesPerPost,
    shared: data.shared as SharedSettings,
    presetId: data.presetId,
    promotedNames: data.promotedNames,
    schedule: stale ? defaultScheduleSettings(now) : schedule,
    seed: data.seed,
    fixedDates:
      !stale && fixedDates?.length && fixedDates.every((date) => date >= earliest)
        ? fixedDates
        : null,
  };
}

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    !draft.media.length &&
    !draft.promotedNames &&
    !draft.shared.resources.length &&
    !draft.shared.tools.length &&
    !draft.shared.techniques.length &&
    !draft.shared.tags.length
  );
}
