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

export type AppealCounts = { approved: number; rejected: number; void: number; pending: number };

export const appealTotal = (c: AppealCounts) => c.approved + c.rejected + c.void + c.pending;

/** "Same file appealed 3× on other models": the row badge, only when one has been. */
export const sameFileAppealBadge = (c: AppealCounts): string | null => {
  const n = appealTotal(c);
  return n > 0 ? `Same file appealed ${n}× on other models` : null;
};

/** "3 appeals (2 rejected, 1 approved)" on other models sharing a file, rejections first since a
 *  re-upload after a denial is what the line is for; null when there are none. */
export const sameFileAppealsText = (c: AppealCounts): string | null => {
  const n = appealTotal(c);
  if (!n) return null;
  const parts = [
    c.rejected && `${c.rejected} rejected`,
    c.approved && `${c.approved} approved`,
    c.void && `${c.void} void`,
    c.pending && `${c.pending} open`,
  ].filter(Boolean);
  return `${n} ${n === 1 ? 'appeal' : 'appeals'} (${parts.join(', ')})`;
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

/** The line under an appeal's decision bar, only saying what the ruling really does. Upholding a hash
 *  flag confirms it and approving reverts it, so either way it leaves Auto-flagged; nothing records the
 *  hash match itself as a false positive. Only text-scan verdicts are stamped as labelled examples. */
export const appealDecisionHint = ({
  hash,
  alsoInAutoFlagged,
  textScan,
}: {
  hash: boolean;
  alsoInAutoFlagged: boolean;
  textScan: boolean;
}): string | undefined =>
  [
    hash && alsoInAutoFlagged && 'Ruling here also settles this model in Auto-flagged.',
    textScan &&
      'Every decision here is stored as a labelled example for tuning the text-scan prompts.',
  ]
    .filter(Boolean)
    .join(' ') || undefined;
