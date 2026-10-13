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
import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { formatDate } from '~/utils/date-helpers';

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

/** Fisher–Yates with the supplied rng so a test can pin the order. */
export function shuffle<T>(items: T[], rng: Rng = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

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

export type UploadedMedia = MediaUploadOnCompleteProps & { status: 'added' };

export type PlannedPost = {
  key: string;
  title: string | null;
  publishedAt: Date;
  media: UploadedMedia[];
};

export function buildPlan(input: {
  media: UploadedMedia[];
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

type CivitaiResourceMeta = { modelVersionId: number };

/** One `scheduleBatch` image: the upload result reshaped to `addPostImageSchema` minus the post
 *  fields, with the shared extra resources merged into `meta.civitaiResources` so the resource
 *  detection picks them up like generator metadata. */
export function toBatchImage(media: UploadedMedia, extraResourceIds: number[]) {
  const meta = (media.meta ?? {}) as Record<string, unknown> & {
    civitaiResources?: CivitaiResourceMeta[];
  };
  const existingResources = Array.isArray(meta.civitaiResources) ? meta.civitaiResources : [];
  const additions = extraResourceIds
    .filter((id) => !existingResources.some((resource) => resource.modelVersionId === id))
    .map((modelVersionId) => ({ modelVersionId }));
  const mergedMeta =
    additions.length || existingResources.length
      ? { ...meta, civitaiResources: [...existingResources, ...additions] }
      : meta;
  const { width, height, hash } = media.metadata as {
    width?: number;
    height?: number;
    hash?: string;
  };
  return {
    name: media.name,
    url: media.url,
    hash,
    height,
    width,
    mimeType: media.mimeType,
    meta: Object.keys(mergedMeta).length ? mergedMeta : undefined,
    type: media.type,
    metadata: media.metadata,
    generationWorkflowId: media.generationWorkflowId,
  };
}

/** The copy-deck wording for a `scheduleBatch` refusal; anything unrecognised is shown as sent. */
export function describeServerError(message: string): string {
  const day = message.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (/daily limit/i.test(message))
    return `Your schedule hit the daily limit${
      day ? ` on ${day}` : ''
    }. Nothing was created — adjust and try again.`;
  if (/too close|minutes between them|minutes from post/i.test(message))
    return `Two posts would be too close together${day ? ` on ${day}` : ''}. Nothing was created.`;
  if (/minutes from now|months out/i.test(message))
    return `Some dates fell outside the ${POST_MINIMUM_SCHEDULE_MINUTES}-minute to 3-month window. Nothing was created.`;
  return message;
}
