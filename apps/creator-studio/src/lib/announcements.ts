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

// The Studio is a single host with no domain color of its own, so the narrow default is the main
// board (what the main app falls back to in getServerSideProps) rather than `all`.
export const DEFAULT_DOMAIN: AnnouncementDomain = 'blue';

export const DOMAIN_LABELS: Record<AnnouncementDomain, { label: string; hint: string }> = {
  blue: { label: 'Civitai', hint: 'civitai.com' },
  red: { label: 'Civitai Red', hint: 'civitai.red' },
  green: { label: 'Civitai Green', hint: 'civitai.green' },
  all: { label: 'Everywhere', hint: 'All domains' },
};

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
