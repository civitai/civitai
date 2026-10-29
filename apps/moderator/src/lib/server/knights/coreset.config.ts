/** Tuning for the Trials core-set manager. Read at request time; change here, not in the UI copy. */
export const CORESET = {
  /** A reference image needs this many Acolyte answers before its failure rate can raise a flag. */
  flagMinAnswers: 20,
  /** Failure rate at or above which a reference image is flagged for moderator review. */
  flagFailureRate: 0.6,
  listLimit: 200,
} as const;

export type CoreSetConfig = { [K in keyof typeof CORESET]: number };
