import type { TextScanResult } from '~/server/services/text-scan/record';
import type { EntityModerationStatus } from '~/shared/utils/prisma/enums';

export type TextScanModeratorSummary = {
  status: EntityModerationStatus;
  nsfwLevel: number | null;
  triggeredLabels: string[];
  reasons: { label: string; reason: string }[];
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
  return {
    status: row.status,
    nsfwLevel: row.nsfwLevel,
    triggeredLabels: row.triggeredLabels,
    reasons: Object.entries(result.labels).map(([label, value]) => ({
      label,
      reason: (value as { reason: string }).reason,
    })),
    updatedAt: row.updatedAt,
  };
}
