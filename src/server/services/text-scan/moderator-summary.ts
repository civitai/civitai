import type {
  TextScanFlagDecision,
  TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import {
  hasOpenTextScanFlag,
  readTextScanFlags,
  TEXT_SCAN_FLAG_LABELS,
} from '~/server/services/text-scan/flag-snapshot';
import type { TextScanResult } from '~/server/services/text-scan/record';
import type { EntityModerationStatus } from '~/shared/utils/prisma/enums';

export type TextScanModeratorSummary = {
  status: EntityModerationStatus;
  nsfwLevel: number | null;
  triggeredLabels: string[];
  reasons: { label: string; reason: string }[];
  /** Part of the text was not scanned: it ran past the segment ceiling. */
  inputCut?: true;
  /** Set when the text was scanned as more than one segment. */
  segments?: number;
  updatedAt: Date;
  /** poi/minor can come from either the main or the web-search row, each with its own status. */
  labelVerdicts?: TextScanLabelVerdict[];
};

export type TextScanLabelVerdict = {
  label: string;
  /** null when the verdict carries no boolean `detected`. */
  detected: boolean | null;
  reason: string;
  source: 'main' | 'web search';
  status: EntityModerationStatus;
  updatedAt: Date;
};

export function summarizeTextScan(
  row: {
    status: EntityModerationStatus;
    nsfwLevel: number | null;
    triggeredLabels: string[];
    result: unknown;
    updatedAt: Date;
  } | null
): TextScanModeratorSummary | null {
  const result = row?.result as Partial<TextScanResult> | null | undefined;
  if (!row || result?.version !== 1 || !result.labels) return null;
  const meta = (result.meta ?? {}) as { inputCut?: unknown; segments?: unknown };
  return {
    status: row.status,
    nsfwLevel: row.nsfwLevel,
    triggeredLabels: row.triggeredLabels,
    reasons: Object.entries(result.labels).map(([label, value]) => ({
      label,
      reason: (value as { reason: string }).reason,
    })),
    ...(meta.inputCut === true ? { inputCut: true as const } : {}),
    ...(typeof meta.segments === 'number' && meta.segments > 1 ? { segments: meta.segments } : {}),
    updatedAt: row.updatedAt,
  };
}

export function textScanLabelDetected(result: unknown, label: string): boolean | null {
  const labels = (result as Partial<TextScanResult> | null | undefined)?.labels as
    | Record<string, { detected?: unknown }>
    | undefined;
  const detected = labels?.[label]?.detected;
  return typeof detected === 'boolean' ? detected : null;
}

export type TextScanFlagVerdict = {
  label: TextScanFlagLabel;
  reason: string | null;
  names: string[];
  at: string | null;
  workflowId: string;
  model: string | null;
  appealGranted: TextScanFlagDecision | null;
  appealUpheld: TextScanFlagDecision | null;
  open: boolean;
};

// The scan that set a sticky flag is overwritten by every rescan; this snapshot is the only
// record of why the flag is on.
export function summarizeTextScanFlags(meta: unknown): TextScanFlagVerdict[] {
  const flags = readTextScanFlags(meta);
  return TEXT_SCAN_FLAG_LABELS.flatMap((label) => {
    const entry = flags[label];
    if (!entry?.workflowId) return [];
    return [
      {
        label,
        reason: entry.reason ?? null,
        names: entry.names ?? [],
        at: entry.at ?? null,
        workflowId: entry.workflowId,
        model: entry.model ?? null,
        appealGranted: entry.appealGranted ?? null,
        appealUpheld: entry.appealUpheld ?? null,
        open: hasOpenTextScanFlag(meta, label),
      },
    ];
  });
}
