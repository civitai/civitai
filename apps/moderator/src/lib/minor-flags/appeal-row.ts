import { NsfwLevel } from '@civitai/shared';

/** Only PG and PG-13 show unblurred; an unrated (0) or higher level is blurred. */
export const shouldBlurThumbnail = (nsfwLevel: number): boolean =>
  nsfwLevel !== NsfwLevel.PG && nsfwLevel !== NsfwLevel.PG13;

export const pastAppealsText = (past: {
  approved: number;
  rejected: number;
  void: number;
  pending: number;
}): string => {
  const parts = [
    past.approved && `${past.approved} approved`,
    past.rejected && `${past.rejected} rejected`,
    past.void && `${past.void} void`,
    past.pending && `${past.pending} other open`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'none';
};

/** The first `max` items and how many were left out. */
export const clipList = <T>(items: T[], max: number): { shown: T[]; more: number } => ({
  shown: items.slice(0, max),
  more: Math.max(0, items.length - max),
});
