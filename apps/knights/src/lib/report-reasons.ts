import {
  isKnightsReportReason,
  KNIGHTS_REPORT_REASONS,
  type KnightsReportReason,
} from '@civitai/shared/new-order';

export const REPORT_REASONS = KNIGHTS_REPORT_REASONS;

export type ReportReason = KnightsReportReason;

export const isReportReason = isKnightsReportReason;
