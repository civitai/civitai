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
