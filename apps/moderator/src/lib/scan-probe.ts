export const SCAN_PROBE_LIMITS = {
  perRun: 5,
  perModeratorPerHour: 100,
  globalPerDay: 500,
} as const;

/** The one wording for every image the probe will not run, whatever the reason. A reason would tell
 *  the operator which images are held, and why. */
export const NOT_AVAILABLE = 'Not available for this image.';

export type RunStatus = 'pending' | 'submitted' | 'submit-failed';

export type ProbeRun = {
  id: string;
  imageId: number;
  createdAt: string;
  status: RunStatus;
};

export type AgeDetectionSignal = {
  domain: string | null;
  apparentAge: number | null;
  ageBand: string | null;
  under13Probability: number | null;
  under18Probability: number | null;
  isChild: boolean | null;
  isMinor: boolean | null;
  isOod: boolean | null;
};

export type Recognition = { label: string; score: number } | null;

/** Named scalars only. Never widen this with a spread of the orchestrator's output: that output
 *  carries derived image bytes (person masks) and blob URLs. */
export type ScanSignals = {
  nsfwLevel: string | null;
  score: number | null;
  csam: boolean | null;
  blockedReason: string | null;
  aiRecognition: Recognition;
  animeRecognition: Recognition;
  human: { label: string; score: number; humanScore: number; noHumanScore: number } | null;
  age: {
    status: string | null;
    childDetected: boolean | null;
    minorDetected: boolean | null;
    oodDetected: boolean | null;
    detections: AgeDetectionSignal[];
  } | null;
  tags: { tag: string; category: string; score: number }[];
};

export type ProbeResult =
  | { state: 'pending' }
  | { state: 'submit-failed' }
  | { state: 'unavailable' }
  /** Sent, but whether the orchestrator accepted it is not known. */
  | { state: 'unknown' }
  | { state: 'running'; workflowStatus: string }
  | { state: 'done'; workflowStatus: string; signals: ScanSignals | null };
