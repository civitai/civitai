/** Tuning for the Trials core-set manager. */
export const CORESET = {
  flagMinAnswers: 20,
  flagFailureRate: 0.6,
  listLimit: 200,
} as const;

export type CoreSetConfig = { [K in keyof typeof CORESET]: number };
