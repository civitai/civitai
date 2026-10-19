import { shortAge } from '$lib/format';

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

export const clipList = <T>(
  items: T[],
  max: number,
  total = items.length
): { shown: T[]; more: number } => {
  const shown = items.slice(0, max);
  return { shown, more: Math.max(0, total - shown.length) };
};

/** "2 d ago": the detail panes space the unit; list rows keep the compact `shortAge`. */
export const ago = (value: Date | string, now = Date.now()) =>
  `${shortAge(value, now).replace(/^(\d+)/, '$1 ')} ago`;

/** "#1 284 311": a model id grouped in threes, as the design writes it; narrow no-break spaces keep it
 *  on one line. */
export const modelRef = (modelId: number) =>
  `#${String(modelId).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')}`;
export const waiting = (value: Date | string) => shortAge(value);

/** Version-specific and `view=basic`, matching the href the main app builds. */
export const modelUrl = (civitaiUrl: string, modelId: number, versionId: number | null = null) =>
  `${civitaiUrl}/models/${modelId}?view=basic${versionId ? `&modelVersionId=${versionId}` : ''}`;

/** "9f3c…a21": enough of a hash to tell two apart at a glance; the full value goes in a title. */
export const shortHash = (hash: string) =>
  hash.length > 9 ? `${hash.slice(0, 4)}…${hash.slice(-3)}` : hash;

/** "2025-11" (UTC), for a dated fact where the day adds nothing. */
export const yearMonth = (value: Date | string) => new Date(value).toISOString().slice(0, 7);
