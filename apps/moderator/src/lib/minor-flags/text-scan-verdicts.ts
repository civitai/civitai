export type TextScanFlagView = {
  at?: string;
  workflowId?: string;
  reason?: string;
  names?: string[];
  appealGranted?: unknown;
};

export type FlagLabel = 'minor' | 'poi';

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

export type LatestScanLabel = { detected: boolean | null; reason: string | null };

export type LatestScan = {
  entityType: string;
  status: string;
  updatedAt: string;
  poi: LatestScanLabel | null;
  minor: LatestScanLabel | null;
};

export const latestScanDisagrees = (scan: LatestScan | null, label: FlagLabel) =>
  scan?.[label]?.detected === false;
