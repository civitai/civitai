import { ArticleStatus } from '@civitai/db-schema/enums';

export { ArticleStatus };

// 'all' maps to an absent `?status=` param.
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

// Humanize the stored reason key; 'other' falls back to the moderator's custom message.
export function humanizeUnpublishReason(reason: string): string {
  return reason.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export type ArticleMetadata = {
  unpublishedReason?: string | null;
  customMessage?: string | null;
  unpublishedAt?: string | null;
} | null;

export const articleUrl = (base: string, id: number) => `${base}/articles/${id}`;
export const userUrl = (base: string, username: string) => `${base}/user/${username}`;
