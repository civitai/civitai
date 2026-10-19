export type TextScanFlagView = {
  at?: string;
  workflowId?: string;
  reason?: string;
  names?: string[];
  textHash?: string;
  /** TextScanPrompt ids the scan ran with (`base` and one per label). */
  promptIds?: unknown;
  appealGranted?: unknown;
};

export type FlagLabel = 'minor' | 'poi';

export type DetectionKind = 'first' | 'redetected';

/** What `Model.meta.textScanFlags[label].redetected` holds: a detection the scan held for a moderator
 *  instead of flagging. `kind: 'redetected'` is text a human had already cleared under another hash;
 *  `'first'` has no human ruling behind it. Nothing was flagged either way. */
export type RedetectionView = {
  kind?: DetectionKind;
  at?: string;
  workflowId: string;
  reason?: string;
  names?: string[];
  textHash: string;
  promptIds?: unknown;
  model?: string | null;
};

/** The human clear a re-detection sits on top of. */
export type PriorClearView = { at?: string; by?: number; via?: string; textHash?: string };

/** An earlier ruling kept on the flag entry (`rulings`), newest few only. */
export type FlagRulingView = {
  decision: string;
  at?: string;
  by?: number;
  textHash?: string | null;
  via?: string;
};

const RULING_TEXT: Record<string, { lead: string; via: Record<string, string> }> = {
  appealGranted: {
    lead: 'Cleared',
    via: { appeal: 'appeal overturned', moderator: 'moderator unflagged' },
  },
  appealUpheld: {
    lead: 'Kept flagged',
    via: { appeal: 'upheld on appeal', moderator: 'kept by moderator' },
  },
};

/** One earlier ruling in words, with the route worded for what that decision was. */
export const rulingText = (decision: string, via?: string) => {
  const text = RULING_TEXT[decision];
  if (!text) return decision;
  const route = via ? text.via[via] : undefined;
  return route ? `${text.lead} (${route})` : text.lead;
};

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

/** A marker with no `kind` predates first-detection review, so it is a re-detection. */
export const detectionKind = (marker: { kind?: DetectionKind }): DetectionKind =>
  marker.kind === 'first' ? 'first' : 'redetected';

const DETECTION_COPY = {
  first: { provenance: 'first detection', showsPriorClear: false },
  redetected: { provenance: 're-detection after a clear', showsPriorClear: true },
} as const;

/** The wording that depends on whether a human ever cleared this label. */
export const detectionCopy = (kind: DetectionKind) => DETECTION_COPY[kind];

/** Which history cards apply. A first detection has no clear behind it, but its entry can still carry
 *  earlier rulings (e.g. an upheld appeal), so those show regardless of kind. */
export const detectionSections = (
  kind: DetectionKind,
  rulings: readonly unknown[] | null | undefined
) => ({
  priorClear: DETECTION_COPY[kind].showsPriorClear,
  rulings: (rulings?.length ?? 0) > 0,
});
