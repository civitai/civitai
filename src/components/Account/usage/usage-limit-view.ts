/**
 * Display rules for one usage-limit row: the bar, "x of y used" and when it frees up, in the
 * viewer's time zone. Plain TypeScript with no React or Mantine, so the Creator Studio panel can
 * mirror it in SvelteKit by copying this file and writing its own markup.
 */

export type UsageLimitWindow = 'rolling' | 'utc-day' | 'utc-month';

/** One row of `GET /api/v1/me/limits` / `user.getUsageLimits`. */
export type UsageLimitRow = {
  id: string;
  area: string;
  label: string;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  windowSeconds: number | null;
  window?: UsageLimitWindow | null;
  nextAt: string | null;
  resetAt: string | null;
};

export type UsageLimitTone = 'ok' | 'warn' | 'full' | 'exempt';

export type UsageLimitView = {
  /** 0–100, for the bar; `null` when there is no bar to draw. */
  percent: number | null;
  tone: UsageLimitTone;
  usedText: string;
  /** The bold line on the right: "+1 at 3:40 PM", "resets 5:00 PM", "available now". */
  when: string | null;
  /** The muted line under it: "all free by 11:05 AM tomorrow", "midnight UTC". */
  whenDetail: string | null;
};

export type UsageLimitViewOptions = {
  now: number | Date;
  /** IANA zone; defaults to the runtime's (the viewer's browser). */
  timeZone?: string;
};

const WARN_AT_PERCENT = 70;

const AREA_NAMES: Record<string, string> = {
  posts: 'Posting',
  articles: 'Posting',
  comments: 'Comments & social',
  generation: 'Generation',
  training: 'Training',
  gifts: 'Gifts',
  apps: 'Apps',
};

export function usageAreaName(area: string) {
  return AREA_NAMES[area] ?? area.charAt(0).toUpperCase() + area.slice(1);
}

const count = (n: number) => n.toLocaleString('en-US');

export function describeUsageLimit(
  row: UsageLimitRow,
  { now, timeZone }: UsageLimitViewOptions
): UsageLimitView {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  if (row.limit === null || row.used === null || row.remaining === null) {
    return { percent: null, tone: 'exempt', usedText: 'No limit', when: null, whenDetail: null };
  }
  const { limit, used, remaining } = row;
  // A limit of 0 never frees up: an entitlement or a first-day block, not a wait.
  if (limit === 0) {
    return {
      percent: 100,
      tone: 'full',
      usedText: 'Not available right now',
      when: null,
      whenDetail: null,
    };
  }

  const percent = Math.min(100, Math.round((used / limit) * 100));
  const tone: UsageLimitTone =
    remaining === 0 ? 'full' : percent >= WARN_AT_PERCENT ? 'warn' : 'ok';
  const usedText =
    `${count(used)} of ${count(limit)} used` +
    (used > 0 && remaining > 0 ? ` · ${count(remaining)} left` : '');

  const at = (iso: string) => formatWhen(Date.parse(iso), nowMs, timeZone);
  const window = row.window ?? 'rolling';

  if (window !== 'rolling') {
    return {
      percent,
      tone,
      usedText,
      when: row.resetAt ? `resets ${at(row.resetAt)}` : null,
      whenDetail: window === 'utc-day' ? 'midnight UTC' : 'start of the month, UTC',
    };
  }

  if (remaining === 0 && row.nextAt) {
    const nextMs = Date.parse(row.nextAt);
    if (nextMs <= nowMs) {
      return { percent, tone, usedText, when: 'available now', whenDetail: null };
    }
    return {
      percent,
      tone,
      usedText,
      when: `+1 at ${at(row.nextAt)}`,
      whenDetail:
        row.resetAt && row.resetAt !== row.nextAt ? `all free by ${at(row.resetAt)}` : null,
    };
  }

  return {
    percent,
    tone,
    usedText,
    when: null,
    whenDetail: used > 0 && row.resetAt ? `all free by ${at(row.resetAt)}` : null,
  };
}

/** The caption on an area's card: "rolling 24 hours", "UTC day". */
export function windowCaption(rows: UsageLimitRow[]): string | null {
  const windows = new Set(rows.map((row) => row.window ?? 'rolling'));
  if (windows.size !== 1) return null;
  const [window] = windows;
  if (window === 'utc-day') return 'UTC day';
  if (window === 'utc-month') return 'UTC month';
  const seconds = new Set(rows.map((row) => row.windowSeconds).filter((s) => s !== null));
  if (seconds.size !== 1) return 'rolling';
  const [s] = seconds as Set<number>;
  if (s === 3600) return 'rolling hour';
  if (s % 3600 === 0) return `rolling ${s / 3600} hours`;
  return 'rolling';
}

/**
 * "3:40 PM" today, "11:05 AM tomorrow", "Tue 9:00 AM" within a week, else "Dec 1". Days are the
 * viewer's calendar days, not 24-hour spans.
 */
export function formatWhen(ms: number, nowMs: number, timeZone?: string) {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(ms);
  const days = calendarDayDiff(nowMs, ms, timeZone);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  if (days > 1 && days < 7) {
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(ms);
    return `${weekday} ${time}`;
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(ms);
}

function calendarDayDiff(fromMs: number, toMs: number, timeZone?: string) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  });
  const day = (ms: number) => Date.parse(`${ymd.format(ms)}T00:00:00Z`);
  return Math.round((day(toMs) - day(fromMs)) / 86_400_000);
}
