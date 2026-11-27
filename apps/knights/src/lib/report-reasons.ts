/** Why a player reports a yes/no question, in the order the picker lists them. Stored as `KnightsQuestionReport.reason`. */
export const REPORT_REASONS = [
  { value: 'image', label: 'Problem with the image' },
  { value: 'question', label: 'Problem with the question' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['value'];

export const isReportReason = (value: unknown): value is ReportReason =>
  REPORT_REASONS.some((reason) => reason.value === value);
