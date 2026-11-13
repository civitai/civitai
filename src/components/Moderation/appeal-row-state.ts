import {
  hasOpenTextScanFlag,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';

type AppealRowFlags = {
  minor: boolean;
  poi: boolean;
  flagSource: string | null;
  flagConfirmedFrom: string | null;
  textScanFlags: unknown;
};

const LABELS: TextScanFlagLabel[] = ['minor', 'poi'];

export function appealRowState(row: AppealRowFlags) {
  const meta = { textScanFlags: row.textScanFlags };
  const poiOpen = row.poi && hasOpenTextScanFlag(meta, 'poi');
  const anyFlagged = row.minor || poiOpen;
  const verdictLabels = LABELS.filter((label) => hasOpenTextScanFlag(meta, label));
  const origin = row.flagConfirmedFrom ?? row.flagSource;
  const sourceLabel = !anyFlagged
    ? 'Reverted'
    : verdictLabels.length
    ? 'Text scan'
    : row.flagSource === 'auto'
    ? 'Auto'
    : 'Mod';
  return {
    anyFlagged,
    bothFlagged: row.minor && poiOpen,
    verdictLabels,
    showHashMatch: row.flagSource != null && origin !== 'text-scan',
    sourceLabel,
  } as const;
}
