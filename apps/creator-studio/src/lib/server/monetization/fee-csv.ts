import type { CsvVersionRow } from '$lib/server/models';

// CSV export of a creator's monetization config — one row per model version, carrying the licensing fee,
// the paid-access gate and the donation goal together. Export only: there is no import, so this is a
// record of what a version is set to rather than a round-trip.
//
// Deliberately a plain dump. No earnings, no buyer counts, no goal progress — each needs a join that turns
// this into a report, and those belong in analytics.
const COLUMNS = [
  'modelId',
  'modelVersionId',
  'model',
  'version',
  'modelType',
  'baseModel',
  'status',
  'usageControl',
  'licensingFee',
  'licensingFeeType',
  'licensingFeeSettlementCurrency',
  'accessKind',
  'timeframeDays',
  'endsAt',
  'downloadPrice',
  'generationPrice',
  'generationFree',
  'generationTrialLimit',
  'donationGoalTitle',
  'donationGoalAmount',
  'donationGoalActive',
] as const;

// UTF-8 BOM so Excel opens non-ASCII model names correctly.
const BOM = '﻿';

const csvCell = (v: string | number | boolean | Date | null | undefined) => {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildFeeCsv(rows: CsvVersionRow[]): string {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.modelId,
        r.versionId,
        r.modelName,
        r.versionName,
        r.modelType,
        r.baseModel,
        r.status,
        r.usageControl,
        r.licensingFee,
        r.licensingFeeType,
        r.licensingFeeSettlementCurrency,
        r.accessKind,
        r.timeframeDays,
        r.endsAt,
        r.downloadPrice,
        r.generationPrice,
        r.generationFree,
        r.generationTrialLimit,
        r.donationGoalTitle,
        r.donationGoalAmount,
        r.donationGoalActive,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return BOM + lines.join('\r\n');
}
