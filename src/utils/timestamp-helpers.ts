import dayjs from '~/shared/utils/dayjs';

/**
 * Discord-style timestamp tags: `<t:UNIX:STYLE>`
 *
 * `UNIX` is a Unix timestamp in *seconds* (not milliseconds). `STYLE` is an
 * optional single-letter format flag. When omitted, Discord defaults to `f`.
 *
 * | Flag | Example output                     | dayjs format |
 * |------|------------------------------------|--------------|
 * | t    | 9:04 PM                            | LT           |
 * | T    | 9:04:00 PM                         | LTS          |
 * | d    | 06/11/2026                         | L            |
 * | D    | June 11, 2026                      | LL           |
 * | f    | June 11, 2026 9:04 PM (default)    | LLL          |
 * | F    | Tuesday, June 11, 2026 9:04 PM     | LLLL         |
 * | R    | in 2 hours / 5 minutes ago         | fromNow()    |
 *
 * The rendered value is always in the *viewer's* local timezone.
 */
export const DISCORD_TIMESTAMP_STYLES = ['t', 'T', 'd', 'D', 'f', 'F', 'R'] as const;
export type DiscordTimestampStyle = (typeof DISCORD_TIMESTAMP_STYLES)[number];

export const DEFAULT_TIMESTAMP_STYLE: DiscordTimestampStyle = 'f';

const STYLE_FORMAT: Record<Exclude<DiscordTimestampStyle, 'R'>, string> = {
  t: 'LT',
  T: 'LTS',
  d: 'L',
  D: 'LL',
  f: 'LLL',
  F: 'LLLL',
};

// Global (with /g) for scanning, anchored variants built where needed. Unix
// seconds: 1-14 digits, optional leading minus for pre-epoch dates.
export const DISCORD_TIMESTAMP_REGEX = /<t:(-?\d{1,14})(?::([tTdDfFR]))?>/g;

export function isDiscordTimestampStyle(value: unknown): value is DiscordTimestampStyle {
  return (
    typeof value === 'string' && DISCORD_TIMESTAMP_STYLES.includes(value as DiscordTimestampStyle)
  );
}

export function normalizeTimestampStyle(value: unknown): DiscordTimestampStyle {
  return isDiscordTimestampStyle(value) ? value : DEFAULT_TIMESTAMP_STYLE;
}

/**
 * Format a Unix-seconds timestamp using a Discord style flag. Pass `utc: true`
 * for a timezone-stable string (used for server render / hydration fallback so
 * the markup matches on both sides before the client swaps to local time).
 */
export function formatDiscordTimestamp(
  seconds: number,
  style: DiscordTimestampStyle = DEFAULT_TIMESTAMP_STYLE,
  opts: { utc?: boolean } = {}
): string {
  if (!Number.isFinite(seconds)) return '';
  const base = opts.utc ? dayjs.utc(seconds * 1000) : dayjs(seconds * 1000);
  if (style === 'R') return base.fromNow();
  return base.format(STYLE_FORMAT[style]);
}

/** Build a canonical `<t:UNIX:STYLE>` tag from a date + style. */
export function buildDiscordTimestampTag(date: Date, style: DiscordTimestampStyle): string {
  const seconds = Math.floor(date.getTime() / 1000);
  return `<t:${seconds}:${style}>`;
}
