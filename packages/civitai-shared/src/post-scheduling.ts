// Post scheduling rules shared by the main app (server + composer), the Creator Studio server and the
// planner element (docs/batch-scheduling-plan.md). Pure: dates in, dates or issues out. Nothing here
// reads the clock on its own — callers pass `now` so previews and server checks agree.
import type { ModelStatus } from '@civitai/db-schema/enums';

export const POST_MINIMUM_SCHEDULE_MINUTES = 10;
export const POST_MAXIMUM_SCHEDULE_MONTHS = 3;
/** Minimum spacing between one creator's scheduled posts when a batch is scheduled. */
export const POST_BATCH_MIN_GAP_MINUTES = 30;
export const POST_BATCH_MAX_POSTS = 200;
export const POST_BATCH_MAX_IMAGES = 500;
/** Posts created per chunked `scheduleBatch` call (docs/batch-scheduling-plan.md); the client sends a
 *  batch as a sequence of these. */
export const POST_BATCH_CHUNK_POSTS = 10;
export const POST_SCHEDULE_JITTER_MAX_MINUTES = 9;
/**
 * The spacing floors under which jitter could pull two posts inside the gap: two adjacent dates
 * can move toward each other by at most `POST_SCHEDULE_JITTER_MAX_MINUTES`, and the on-the-hour
 * nudge adds one more.
 */
export const POST_BATCH_MIN_EVERY_MINUTES = 60;
export const POST_BATCH_MIN_SPREAD_SLOT_MINUTES = 40;

const MINUTE_MS = 60_000;

/** `date` plus `months`, with the day clamped to the end of the target month (dayjs semantics), in
 *  local time — the same arithmetic as the main app's `increaseDate(date, n, 'months')`. */
export function addMonthsClamped(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

/** The instants a post may be scheduled for, relative to `now`. */
export function scheduleWindow(now: Date): { min: Date; max: Date } {
  return {
    min: addMinutes(now, POST_MINIMUM_SCHEDULE_MINUTES),
    max: addMonthsClamped(now, POST_MAXIMUM_SCHEDULE_MONTHS),
  };
}

/** `YYYY-MM-DD` of the UTC day `date` falls in — the day the publish sweep and the daily reward use. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Rescheduling one post

export type PostScheduleTarget = Date | 'now';

/**
 * Why a scheduled post may not move to `target`, or null when it may.
 *
 * Stricter than `post.update`, which quietly publishes immediately when the sent date is too soon
 * (clock-drift tolerance) and otherwise accepts any future date unchecked, even past the maximum
 * window. A calendar drop that publishes immediately is not what the creator asked for, so this
 * refuses instead; publishing now is its own explicit request.
 */
export function getPostScheduleError(
  post: { publishedAt: Date | null },
  target: PostScheduleTarget,
  now: Date
): string | null {
  if (!post.publishedAt || post.publishedAt <= now)
    return 'Only scheduled posts can be rescheduled or published early';
  if (target === 'now') return null;
  const { min, max } = scheduleWindow(now);
  if (target < min)
    return `Schedule date must be at least ${POST_MINIMUM_SCHEDULE_MINUTES} minutes in the future`;
  if (target > max)
    return `Schedule date cannot be more than ${POST_MAXIMUM_SCHEDULE_MONTHS} months in the future`;
  return null;
}

export type PostScheduleScope = 'post' | 'version' | 'model';

export type SchedulablePost = {
  userId: number;
  modelVersion: {
    status: ModelStatus;
    model: { userId: number; status: ModelStatus };
  } | null;
};

/**
 * Whose schedule a post's date belongs to.
 *
 * A post on a Scheduled version is published by that version's release (publishModelVersionById
 * and publishModelById both fan the date out to its owner's still-scheduled posts), so moving it
 * means moving the release — the whole model when the model itself has not gone live yet. Same
 * split the version page makes in `handlePublishClick`.
 */
export function getPostScheduleScope(post: SchedulablePost): PostScheduleScope {
  const version = post.modelVersion;
  if (!version || version.status !== 'Scheduled') return 'post';
  if (version.model.userId !== post.userId) return 'post';
  return version.model.status === 'Published' ? 'version' : 'model';
}

// ---------------------------------------------------------------------------------------------
// Generating a batch schedule

/** Returns a number in [0, 1). */
export type Rng = () => number;

/** mulberry32: a small deterministic generator, so a preview keyed on one seed does not reshuffle
 *  its minutes on every render and the server can reproduce the client's dates from the seed. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    p;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `date` moved 1..`POST_SCHEDULE_JITTER_MAX_MINUTES` minutes later, one more if that lands on :00,
 *  seconds cleared. Never returns an on-the-hour instant. */
export function applyJitter(date: Date, rng: Rng): Date {
  const minutes = 1 + Math.floor(rng() * POST_SCHEDULE_JITTER_MAX_MINUTES);
  const moved = addMinutes(date, minutes);
  moved.setUTCSeconds(0, 0);
  return moved.getUTCMinutes() === 0 ? addMinutes(moved, 1) : moved;
}

export type ScheduleGeneration = { ok: true; dates: Date[] } | { ok: false; issue: string };

/** `count` dates from `start`, `everyMinutes` apart, each jittered. */
export function generateEverySchedule(input: {
  start: Date;
  everyMinutes: number;
  count: number;
  rng: Rng;
}): ScheduleGeneration {
  const { start, everyMinutes, count, rng } = input;
  if (count < 1) return { ok: false, issue: 'Add at least one post to schedule.' };
  if (!Number.isFinite(everyMinutes) || everyMinutes < POST_BATCH_MIN_EVERY_MINUTES)
    return {
      ok: false,
      issue: `Posts need at least ${POST_BATCH_MIN_EVERY_MINUTES / 60} hour between them.`,
    };
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) dates.push(applyJitter(addMinutes(start, i * everyMinutes), rng));
  return { ok: true, dates };
}

/** `count` dates spread evenly between `from` and `to`, each jittered, none later than `to`. The
 *  first base lands on `from`; the last base stops one jitter short of `to` so the jitter cannot
 *  carry it past the range the creator picked. */
export function generateSpreadSchedule(input: {
  from: Date;
  to: Date;
  count: number;
  rng: Rng;
}): ScheduleGeneration {
  const { from, to, count, rng } = input;
  if (count < 1) return { ok: false, issue: 'Add at least one post to schedule.' };
  const end = addMinutes(to, -(POST_SCHEDULE_JITTER_MAX_MINUTES + 1));
  if (end <= from) return { ok: false, issue: 'The end of the range must come after its start.' };
  if (count === 1) return { ok: true, dates: [applyJitter(from, rng)] };
  const slotMinutes = (end.getTime() - from.getTime()) / MINUTE_MS / (count - 1);
  if (slotMinutes < POST_BATCH_MIN_SPREAD_SLOT_MINUTES)
    return {
      ok: false,
      issue: `${count} posts don't fit in that range with ${POST_BATCH_MIN_GAP_MINUTES} minutes between them. Widen the range or post fewer.`,
    };
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) {
    const base = new Date(from.getTime() + Math.round(i * slotMinutes) * MINUTE_MS);
    dates.push(applyJitter(base, rng));
  }
  return { ok: true, dates };
}

// ---------------------------------------------------------------------------------------------
// Validating a batch schedule

export type ScheduleIssueCode = 'shape' | 'lead' | 'window' | 'onTheHour' | 'gap' | 'cap';

export type ScheduleIssue = {
  code: ScheduleIssueCode;
  message: string;
  /** Index into `publishedAts` of the offending post, when there is one. */
  index?: number;
  /** UTC day (`YYYY-MM-DD`) for a cap issue. */
  day?: string;
};

export type SchedulePerDay = { day: string; existing: number; incoming: number };

export type BatchScheduleValidation = {
  ok: boolean;
  issues: ScheduleIssue[];
  /** Every UTC day that receives an incoming post, with the creator's existing count on it. */
  perDay: SchedulePerDay[];
};

/**
 * Every rule a batch must pass before anything is written, in one place so the composer's preview
 * and the server's check cannot disagree. `existingPublishedAts` are the creator's other posts with
 * a publish date from the start of today (UTC) onward: live today or still pending. Days are UTC,
 * matching the publish sweep and the daily reward's dedup.
 */
export function validateBatchSchedule(input: {
  now: Date;
  publishedAts: Date[];
  existingPublishedAts: Date[];
  dailyLimit: number;
  minGapMinutes?: number;
  minLeadMinutes?: number;
  maxMonths?: number;
  maxPosts?: number;
}): BatchScheduleValidation {
  const {
    now,
    publishedAts,
    existingPublishedAts,
    dailyLimit,
    minGapMinutes = POST_BATCH_MIN_GAP_MINUTES,
    minLeadMinutes = POST_MINIMUM_SCHEDULE_MINUTES,
    maxMonths = POST_MAXIMUM_SCHEDULE_MONTHS,
    maxPosts = POST_BATCH_MAX_POSTS,
  } = input;
  const issues: ScheduleIssue[] = [];

  if (publishedAts.length < 1)
    issues.push({ code: 'shape', message: 'Add at least one post to schedule.' });
  if (publishedAts.length > maxPosts)
    issues.push({
      code: 'shape',
      message: `A batch can schedule up to ${maxPosts} posts; this one has ${publishedAts.length}.`,
    });

  const min = addMinutes(now, minLeadMinutes);
  const max = addMonthsClamped(now, maxMonths);
  publishedAts.forEach((date, index) => {
    const post = index + 1;
    if (date < min)
      issues.push({
        code: 'lead',
        index,
        message: `Post ${post} must be at least ${minLeadMinutes} minutes from now.`,
      });
    else if (date > max)
      issues.push({
        code: 'window',
        index,
        message: `Post ${post} is more than ${maxMonths} months out. Shorten the gap or the range.`,
      });
    if (date.getUTCMinutes() === 0)
      issues.push({
        code: 'onTheHour',
        index,
        message: `Post ${post} lands exactly on the hour. Move it by a few minutes.`,
      });
  });

  // An existing/existing pair is not this batch's problem; a pair involving an incoming post is
  // reported on the incoming one.
  const all = [
    ...publishedAts.map((date, index) => ({ date, index })),
    ...existingPublishedAts.map((date) => ({ date, index: -1 })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  const gapMs = minGapMinutes * MINUTE_MS;
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1];
    const next = all[i];
    if (next.date.getTime() - prev.date.getTime() >= gapMs) continue;
    if (prev.index < 0 && next.index < 0) continue;
    const incoming = next.index >= 0 ? next : prev;
    const other = incoming === next ? prev : next;
    issues.push({
      code: 'gap',
      index: incoming.index,
      message:
        other.index >= 0
          ? `Post ${incoming.index + 1} goes live ${Math.round(
              Math.abs(incoming.date.getTime() - other.date.getTime()) / MINUTE_MS
            )} minutes from post ${
              other.index + 1
            }. Posts need at least ${minGapMinutes} minutes between them.`
          : `Post ${
              incoming.index + 1
            } is too close to a post you already have scheduled. Move it ${minGapMinutes} minutes or more.`,
    });
  }

  const existingByDay = new Map<string, number>();
  for (const date of existingPublishedAts) {
    const day = utcDayKey(date);
    existingByDay.set(day, (existingByDay.get(day) ?? 0) + 1);
  }
  const incomingByDay = new Map<string, number>();
  for (const date of publishedAts) {
    const day = utcDayKey(date);
    incomingByDay.set(day, (incomingByDay.get(day) ?? 0) + 1);
  }
  const perDay: SchedulePerDay[] = [...incomingByDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, incoming]) => ({ day, incoming, existing: existingByDay.get(day) ?? 0 }));
  for (const { day, existing, incoming } of perDay) {
    if (existing + incoming <= dailyLimit) continue;
    issues.push({
      code: 'cap',
      day,
      message: `${day} would have ${
        existing + incoming
      } posts; your daily limit is ${dailyLimit}. Move ${
        existing + incoming - dailyLimit
      } or let us fix the spacing.`,
    });
  }

  return { ok: issues.length === 0, issues, perDay };
}
