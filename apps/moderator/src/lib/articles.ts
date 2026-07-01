import { ArticleStatus } from '@civitai/db-schema/enums';

export { ArticleStatus };

// The moderator queue reviews unpublished articles; status is a single-select filter with an "all"
// default (both unpublished statuses). 'all' maps to an absent `?status=` param.
export type ArticleStatusFilter = 'all' | 'Unpublished' | 'UnpublishedViolation';

export const articleStatusFilters: { value: ArticleStatusFilter; label: string }[] = [
  { value: 'all', label: 'All unpublished' },
  { value: 'Unpublished', label: 'User unpublished' },
  { value: 'UnpublishedViolation', label: 'ToS violation' },
];

export const articleStatusBadge: Record<string, { label: string; class: string }> = {
  Unpublished: { label: 'Unpublished', class: 'bg-yellow-500/15 text-yellow-300' },
  UnpublishedViolation: { label: 'ToS Violation', class: 'bg-red-500/15 text-red-300' },
};

// The unpublish-reason messages live in the main app (moderation-helpers, ~90 entries) — not worth
// duplicating for v1. Humanize the stored key ('mature-real-person' → 'Mature Real Person'); a 'other'
// reason falls back to the moderator's custom message.
export function humanizeUnpublishReason(reason: string): string {
  return reason.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export type ArticleMetadata = {
  unpublishedReason?: string | null;
  customMessage?: string | null;
  unpublishedAt?: string | null;
} | null;

// `base` comes from CIVITAI_APP_URL via layout data (env-driven, client-rendered links).
export const articleUrl = (base: string, id: number) => `${base}/articles/${id}`;
export const userUrl = (base: string, username: string) => `${base}/user/${username}`;
