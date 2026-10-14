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

/** Is a flag still in force: minor, or real person with a text-scan verdict not yet lifted. */
export const flagInForce = (row: { minor: boolean; poi: boolean; textScanFlags: unknown }) =>
  row.minor || (row.poi && isOpenVerdict(flagsOf(row.textScanFlags)?.poi));

export const openVerdicts = (v: unknown) =>
  FLAG_LABELS.flatMap((label) => {
    const flag = flagsOf(v)?.[label];
    return flag && isOpenVerdict(flag) ? [{ label, flag }] : [];
  });
