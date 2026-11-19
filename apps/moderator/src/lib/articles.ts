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
  unpublishedBy?: number | null;
  /** Written by the main app when a block moves an article to UnpublishedViolation. */
  statusBeforeViolation?: string | null;
} | null;

/**
 * Whether a moderator may restore this unpublished article. An Unpublished one only when someone
 * other than its author unpublished it: one with no `unpublishedBy` predates that key and was its
 * author's own unpublish too, which only the author may undo.
 */
export function canRestoreArticle(article: {
  status: string;
  userId: number;
  metadata: ArticleMetadata;
}): boolean {
  if (article.status === ArticleStatus.UnpublishedViolation) return true;
  if (article.status !== ArticleStatus.Unpublished) return false;
  const by = article.metadata?.unpublishedBy;
  return by != null && by !== article.userId;
}

/**
 * Where a moderator's restore puts the article: the status the block recorded, so a draft goes
 * back to its author as it was. A row with none (blocked before it was recorded) is published only
 * if it had been, since publishing it would publish something its author never did.
 */
export function restoreStatus(
  metadata: ArticleMetadata | undefined,
  publishedAt: Date | null
): ArticleStatus {
  const before = metadata?.statusBeforeViolation;
  if (
    before === ArticleStatus.Draft ||
    before === ArticleStatus.Unpublished ||
    before === ArticleStatus.Published
  )
    return before;
  return publishedAt ? ArticleStatus.Published : ArticleStatus.Draft;
}

export const articleUrl = (base: string, id: number) => `${base}/articles/${id}`;
