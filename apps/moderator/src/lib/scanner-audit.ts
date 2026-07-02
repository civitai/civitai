import { ReviewVerdict } from '@civitai/db-schema/enums';

export { ReviewVerdict };

// Resolved display content for one audit item (client-safe shape; the server resolver lives in
// $lib/server/scanner-content.service).
export type ScanContent = {
  contentHash: string;
  scanner: string;
  text?: string;
  positivePrompt?: string;
  negativePrompt?: string;
  imageId?: number;
  imageUrl?: string;
  labelReasons?: Record<string, string>;
  userId?: number;
  unavailable: boolean;
  unavailableReason?: string;
};

export const SCANNER_MODES = [
  { value: 'text', label: 'Text' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'media', label: 'Media' },
] as const;

export type ScannerAuditMode = (typeof SCANNER_MODES)[number]['value'];
export type Scanner = 'xguard_text' | 'xguard_prompt' | 'image_ingestion';
export type QueueView = 'triggered' | 'near-miss';

export function modeToScanner(mode: ScannerAuditMode): Scanner {
  return mode === 'text' ? 'xguard_text' : mode === 'prompt' ? 'xguard_prompt' : 'image_ingestion';
}

export function isValidMode(s: string | undefined): s is ScannerAuditMode {
  return s === 'text' || s === 'prompt' || s === 'media';
}

export const verdictShort: Record<string, string> = {
  [ReviewVerdict.TruePositive]: 'TP',
  [ReviewVerdict.FalsePositive]: 'FP',
  [ReviewVerdict.TrueNegative]: 'TN',
  [ReviewVerdict.FalseNegative]: 'FN',
  [ReviewVerdict.Unsure]: '?',
};

// Green = the scanner was right (TP/TN), red = wrong (FP/FN), gray = unsure.
export const verdictClass: Record<string, string> = {
  [ReviewVerdict.TruePositive]: 'bg-teal-500/15 text-teal-300',
  [ReviewVerdict.TrueNegative]: 'bg-teal-500/15 text-teal-300',
  [ReviewVerdict.FalsePositive]: 'bg-red-500/15 text-red-300',
  [ReviewVerdict.FalseNegative]: 'bg-red-500/15 text-red-300',
  [ReviewVerdict.Unsure]: 'bg-muted text-muted-foreground',
};

// The (model triggered?, moderator says it should trigger?) → verdict matrix.
export function verdictFromAnswer(
  modelTriggered: boolean,
  modSaysShouldTrigger: boolean
): ReviewVerdict {
  if (modelTriggered)
    return modSaysShouldTrigger ? ReviewVerdict.TruePositive : ReviewVerdict.FalsePositive;
  return modSaysShouldTrigger ? ReviewVerdict.FalseNegative : ReviewVerdict.TrueNegative;
}

export const VERDICT_ORDER = [
  ReviewVerdict.TruePositive,
  ReviewVerdict.FalsePositive,
  ReviewVerdict.TrueNegative,
  ReviewVerdict.FalseNegative,
  ReviewVerdict.Unsure,
] as const;
