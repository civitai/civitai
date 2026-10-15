export type TextScanFlagView = {
  at?: string;
  workflowId?: string;
  reason?: string;
  names?: string[];
  appealGranted?: unknown;
};

export type FlagLabel = 'minor' | 'poi';

/** What `Model.meta.textScanFlags[label].redetected` holds: a detection on text a human had already
 *  cleared under another hash. Nothing was flagged. */
export type RedetectionView = {
  at?: string;
  workflowId: string;
  reason?: string;
  names?: string[];
  textHash: string;
  model?: string | null;
};

/** The human clear a re-detection sits on top of. */
export type PriorClearView = { at?: string; by?: number; via?: string; textHash?: string };

export const CLEAR_VIA_LABELS: Record<string, string> = {
  appeal: 'appeal overturned',
  moderator: 'moderator unflagged',
};

export const clearViaLabel = (via: string | undefined) =>
  (via && CLEAR_VIA_LABELS[via]) || 'cleared';

const FLAG_LABELS: FlagLabel[] = ['minor', 'poi'];

export const flagsOf = (v: unknown) =>
  v && typeof v === 'object' ? (v as Partial<Record<FlagLabel, TextScanFlagView>>) : null;

// Mirrors hasOpenTextScanFlag: a ruling stub has no workflowId, and a granted verdict is lifted.
export const isOpenVerdict = (flag: TextScanFlagView | undefined) =>
  !!flag?.workflowId && !flag.appealGranted;

type FlagRow = { minor: boolean; poi: boolean; textScanFlags: unknown };

export const poiInForce = (row: FlagRow) =>
  row.poi && isOpenVerdict(flagsOf(row.textScanFlags)?.poi);

export const flagInForce = (row: FlagRow) => row.minor || poiInForce(row);

export const openVerdicts = (v: unknown) =>
  FLAG_LABELS.flatMap((label) => {
    const flag = flagsOf(v)?.[label];
    return flag && isOpenVerdict(flag) ? [{ label, flag }] : [];
  });

export type LatestScanSource = 'main' | 'web search';

/** One label's verdict, from whichever scan row last settled it. */
export type LatestScanLabel = {
  detected: boolean | null;
  reason: string | null;
  source: LatestScanSource;
  status: string;
  updatedAt: string;
};

export type LatestScan = { poi: LatestScanLabel | null; minor: LatestScanLabel | null };

export const latestScanDisagrees = (scan: LatestScan | null, label: FlagLabel) =>
  scan?.[label]?.detected === false;

/** A verdict from a row whose rescan has not finished carries the rescan's updatedAt, not its own. */
export const scanVerdictProvenance = (
  v: Pick<LatestScanLabel, 'source' | 'status'>
): { source: string; note: string | null } => ({
  source: v.source === 'main' ? 'main scan' : v.source,
  note:
    v.status === 'Succeeded'
      ? null
      : v.status === 'Pending'
      ? 'rescan pending — last verdict shown'
      : 'last rescan failed — last verdict shown',
});

export const scanVerdictText = (v: Pick<LatestScanLabel, 'detected' | 'reason'>) => {
  const verdict = v.detected ? 'detected' : v.detected === false ? 'not detected' : 'no verdict';
  return v.reason ? `${verdict} — ${v.reason}` : verdict;
};
