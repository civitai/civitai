import type { DomainColor } from '@civitai/db-schema/enums';

// Mirrors upsertCreatorAnnouncementSchema in the main app (src/server/schema/announcement.schema.ts).
// The endpoint rejects anything longer, so these must not drift upward without it.
export const TITLE_MAX = 120;
export const CONTENT_MAX = 5000;
export const LINK_TEXT_MAX = 40;

export const DOMAIN_COLORS = [
  'blue',
  'red',
  'green',
  'all',
] as const satisfies readonly DomainColor[];
export type AnnouncementDomain = (typeof DOMAIN_COLORS)[number];

/**
 * The two sites a creator chooses between. `all` is not offered: it is the same audience as
 * ticking both, and a third state meaning "the other two" is one the creator has to reason about
 * for no gain.
 *
 * 🔴 The colour names do NOT match the sites. Verified against the live SSR pool config:
 * `SERVER_DOMAIN_GREEN=civitai.com` and `SERVER_DOMAIN_BLUE=civitai.red`. Read the mapping here,
 * never from the colour word.
 *
 * 🔴 `red` is deliberately absent and must stay absent. `SERVER_DOMAIN_RED` is *also* civitai.red,
 * and `getRequestDomainColor` walks `['green','blue','red']` returning the first match — so blue
 * always wins and no incoming request ever resolves to `red`. An announcement written as `red`
 * saves cleanly and is then invisible to everyone, with nothing to indicate why.
 */
export const DOMAIN_CHIPS = [
  { color: 'green', label: 'Civitai', host: 'civitai.com' },
  { color: 'blue', label: 'Civitai Red', host: 'civitai.red' },
] as const satisfies readonly { color: DomainColor; label: string; host: string }[];

export const DEFAULT_DOMAINS: AnnouncementDomain[] = DOMAIN_CHIPS.map((c) => c.color);

// Labels for rendering an announcement's stored domains, including values the picker does not
// offer — `all` is on every migrated profile banner, and `red` on anything written before this.
export const DOMAIN_LABELS: Record<AnnouncementDomain, { label: string; hint: string }> = {
  green: { label: 'civitai.com', hint: 'Civitai' },
  blue: { label: 'civitai.red', hint: 'Civitai Red' },
  // Only reachable on rows written before the picker existed — no request resolves to this colour.
  red: { label: 'Unrouted', hint: 'no site resolves to this' },
  all: { label: 'Everywhere', hint: 'All domains' },
};

/**
 * Unless `registerEnumArrayTypeParsers` has run, pg hands a user-defined enum array back as the raw
 * literal `{green,blue}` — and `[...new Set(value)]` on that string yielded one chip per LETTER.
 * `hooks.server.ts` registers the parser at boot but fail-open, so this must stand on its own.
 */
export function toDomainArray(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.replace(/^\{|\}$/g, '').split(',')
      : [];

  return [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))];
}

/**
 * Shortest announcement the server will store; the picker enforces it so the creator sees the
 * constraint while choosing. Must stay in step with MIN_ANNOUNCEMENT_DURATION_MS in
 * src/server/services/creator-announcement.service.ts.
 */
export const MIN_ANNOUNCEMENT_DURATION_MS = 60 * 60 * 1000;

export type AnnouncementAllowance = {
  eligible: boolean;
  tier: string;
  score: number;
  minScore: number;
  used: number;
  limit: number;
  windowDays: number;
  nextAvailableAt: string | null;
};

// Three states, not two: below the score floor is not "come back later" — waiting never grants a
// slot — so the screens key off this rather than off `used < limit` alone.
export type AllowanceState = 'ineligible' | 'exhausted' | 'available';

export function allowanceState(allowance: AnnouncementAllowance): AllowanceState {
  if (!allowance.eligible) return 'ineligible';
  return allowance.used < allowance.limit ? 'available' : 'exhausted';
}

export function windowLabel(days: number): string {
  if (days === 7) return 'week';
  if (days === 14) return '2 weeks';
  if (days === 30) return 'month';
  return `${days} days`;
}

// AnnouncementCard renders the cover in a fixed 10rem box with `object-cover`, so anything that
// isn't square loses its edges rather than shrinking to fit.
export const COVER_ASPECT_LABEL = 'Square (1:1) works best. Covers are cropped to a square.';

// Wide enough to let a 1024x1010 export through; a real 16:9 or 3:4 upload is nowhere near it.
export const COVER_ASPECT_TOLERANCE = 0.02;

export function coverAspectWarning(
  width: number | null | undefined,
  height: number | null | undefined
): string | null {
  if (!width || !height) return null;
  if (Math.abs(width - height) / Math.max(width, height) <= COVER_ASPECT_TOLERANCE) return null;
  const trimmed = width > height ? 'sides' : 'top and bottom';
  return `This image is ${width}×${height}. Covers are shown as a square, so the ${trimmed} will be cropped.`;
}
