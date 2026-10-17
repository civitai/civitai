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

/** An article that is not live, in a few words — the queue row's note and the article panel's "nothing
 *  to unpublish" line. Published has none: it is the state these describe a departure from. */
export const ARTICLE_STATUS_NOTES: Partial<Record<string, string>> = {
  UnpublishedViolation: 'unpublished as a violation',
  Unpublished: 'unpublished by its author',
  Draft: 'a draft',
  Processing: 'still processing',
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
