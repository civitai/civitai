import { getBrowsingLevelLabel } from '@civitai/shared';
import { bytes, ordinal, plural } from '$lib/format';
import { ago, yearMonth } from '$lib/minor-flags/appeal-row';

/** The payload of `<tab>/detail/[modelId]`: what only the open detail pane shows. */
export type ModelFlagDetail = {
  /** Images on the owner's posts of the model; the row carries the first few. */
  previewCount: number;
  /** Pending and Processing reports on the model. */
  openReports: number;
  versionCount: number;
  latestPublishedAt: string | null;
  nsfwLevel: number;
  ratingLocked: boolean;
  downloads: number | null;
  generations: number | null;
  mainFile: MainFile | null;
  uploaderJoinedAt: string | null;
  uploaderPublished: number;
  uploaderModUnpublished: number;
  /** Flags lifted on the uploader's OTHER models: a hash flag rolled back, or a text-scan flag granted. */
  flagsReverted: { count: number; lastAt: string | null };
  /** Null when the moderator database could not be read. */
  strikes: number | null;
  notes: number | null;
  /** Per TextScanPrompt id asked for: its version within its key (the first saved is 1). */
  promptVersions: Record<string, number>;
};

export type MainFile = { name: string; sizeKB: number; scansOk: boolean; otherFiles: number };

/** One EntityModeration row of the text scan, as the queue rows carry it. */
export type ScanRowView = {
  workflowId: string | null;
  textHash: string | null;
  status: string;
  updatedAt: string;
};
export type ScanRows = { main: ScanRowView | null; search: ScanRowView | null } | null;

export async function fetchModelFlagDetail(
  tabPath: string,
  modelId: number,
  promptIds: readonly number[] = []
): Promise<ModelFlagDetail> {
  const query = promptIds.length ? `?prompts=${[...new Set(promptIds)].join(',')}` : '';
  const res = await fetch(`${tabPath}/detail/${modelId}${query}`);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** The label's own prompt, else the base prompt: the ids a flag entry's `promptIds` carries. */
export const flagPromptId = (promptIds: unknown, label: string): number | null => {
  if (!promptIds || typeof promptIds !== 'object') return null;
  const ids = promptIds as Record<string, unknown>;
  const id = ids[label] ?? ids.base;
  return typeof id === 'number' ? id : null;
};

/** Bounded reads stop at one past this and pass that sentinel as the total, so `previewCountText` reads "N+" rather than too low a figure. */
export const PREVIEW_COUNT_CAP = 100;

export const previewCountText = (total: number, shown: number) => {
  const count =
    total === PREVIEW_COUNT_CAP + 1
      ? `${PREVIEW_COUNT_CAP}+ preview images`
      : plural(total, 'preview image');
  return `${count}${total > shown ? `, ${shown} shown` : ''}`;
};

/** Null for a first appeal: "1st appeal this year" says nothing a moderator needs. */
export const appealOrdinalText = (nth: number) =>
  nth > 1 ? `${ordinal(nth)} appeal by this uploader this year` : null;

export const versionsText = (count: number, latestPublishedAt: string | null, now = Date.now()) =>
  `${count}, ${
    latestPublishedAt ? `latest published ${ago(latestPublishedAt, now)}` : 'none published'
  }`;

export const ratingText = (nsfwLevel: number, locked: boolean) =>
  `${getBrowsingLevelLabel(nsfwLevel)}${locked ? ', locked' : ''}`;

export const filesText = (file: MainFile | null) =>
  file
    ? `${file.name}, ${bytes(file.sizeKB)}, ${file.scansOk ? 'scans ok' : 'scans not clean'}${
        file.otherFiles ? ` · +${plural(file.otherFiles, 'more file')}` : ''
      }`
    : 'none';

export const flagsText = (reverted: ModelFlagDetail['flagsReverted'], strikes: number | null) => {
  const flags = reverted.count
    ? `${plural(reverted.count, 'flag')} reverted on another model${
        reverted.lastAt ? `, ${yearMonth(reverted.lastAt)}` : ''
      }`
    : 'none reverted';
  return `${flags} · ${strikes === null ? 'strikes unavailable' : plural(strikes, 'strike')}`;
};

/** Which scan raised the flag, while that scan's row still carries its workflow. A rescan replaces the
 *  row's workflow, after which nothing stored says which pass it was. */
export const flagScanSource = (
  workflowId: string | null | undefined,
  rows: ScanRows
): 'main' | 'web search' | null => {
  if (!workflowId || !rows) return null;
  if (rows.search?.workflowId === workflowId) return 'web search';
  if (rows.main?.workflowId === workflowId) return 'main';
  return null;
};

/** Whether the text the newest scan read is the text that was flagged. No claim while a rescan is
 *  pending (the row still holds the previous text's hash) or when the scan stored no hash. */
export const textSinceFlag = (
  flagHash: string | null | undefined,
  rows: ScanRows
): 'unchanged' | 'changed' | null => {
  if (!flagHash || !rows) return null;
  const present = [rows.main, rows.search].filter((r): r is ScanRowView => !!r);
  if (present.some((r) => r.status === 'Pending')) return null;
  const newest = present
    .filter((r) => r.textHash)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (!newest) return null;
  return newest.textHash === flagHash ? 'unchanged' : 'changed';
};

/** The provenance line of a hash flag: "hash sweep, 3 d ago · 27 days left, then the flag is presumed
 *  correct". `daysLeft` is null outside the review window's reach (a confirmed or manual flag). */
export const hashSweepText = (
  flaggedAt: Date | string | null,
  daysLeft: number | null,
  now = Date.now()
) => {
  const parts = [flaggedAt ? `hash sweep, ${ago(flaggedAt, now)}` : 'hash sweep'];
  if (daysLeft === 0) parts.push('review window closed; the flag is presumed correct');
  else if (daysLeft !== null)
    parts.push(`${plural(daysLeft, 'day')} left, then the flag is presumed correct`);
  return parts.join(' · ');
};

/** Why a hash flag was applied, in the words the Flagged and Appeals why-cards share. */
export const HASH_FLAG_REASON =
  'Its main file is byte-identical to a file in a model a moderator flagged as minor. The uploader is the same account, so the flag was applied automatically.';
