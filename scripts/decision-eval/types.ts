export type ChoiceOption = { key: string; description: string };

export type DecisionQuestion =
  | { id: string; type: 'choice'; instructions: string; options: readonly ChoiceOption[] }
  | { id: string; type: 'noul'; instructions: string }
  /** Scored in INDEX space: `value` is a position in `criteria`, on every arm. */
  | { id: string; type: 'score'; instructions: string; criteria: readonly string[] };

export type DecisionState = Record<string, string>;

export type ImageInput = { bytes: Uint8Array; contentType: string; sha256: string };

export type TextDecisionRequest = {
  state: DecisionState;
  questions: readonly DecisionQuestion[];
};

export type ImageDecisionRequest = TextDecisionRequest & { images: readonly ImageInput[] };

/**
 * One answer, normalised across arms. Hosted Jev reports no unknown mass, no
 * abstention and no noul confidence, so those are `null` there — never 0.
 */
export type NormalizedAnswer = {
  id: string;
  type: DecisionQuestion['type'];
  /** choice: the option key; noul: P(yes); score: rubric index. */
  value: string | number;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  unknown: number | null;
  abstained: boolean | null;
};

export type DecisionResult = {
  answers: NormalizedAnswer[];
  /** The build the server or vendor reports answered. */
  build: string;
  latencyMs: number;
  /** The card a self-hosted arm ran on; recorded per prediction because a rolling run can span machines. */
  hardware?: string;
};

export type Hosting = 'self-hosted' | 'third-party';

export type HostKind = 'loopback' | 'private' | 'allowlisted';

export interface TextDecisionModel {
  /** Stable id for the arm AND its launch configuration; part of the run key. */
  readonly configId: string;
  readonly hosting: Hosting;
  /** True when no third party retains the request: self-hosted, or sent with a ZDR routing flag. */
  readonly zeroDataRetention: boolean;
  /** Where a self-hosted arm lives, as far as its URL can tell. */
  readonly hostKind?: HostKind;
  decide(request: TextDecisionRequest): Promise<DecisionResult>;
}

/** Only a self-hosted arm can receive images — the type forbids anything else. */
export interface ImageDecisionModel extends TextDecisionModel {
  readonly hosting: 'self-hosted';
  decideWithImages(request: ImageDecisionRequest): Promise<DecisionResult>;
}

export type DataClass = 'moderation-image' | 'support-text' | 'public-text';

export type Split = 'train' | 'dev' | 'test';

export type ImageRef = { url: string; sha256?: string };

export type ManifestItem = {
  itemId: string;
  groupKey: string;
  /** ISO timestamp of the underlying decision. */
  ts: string;
  split: Split;
  state: DecisionState;
  imageRefs?: ImageRef[];
  slices?: Record<string, string>;
  /** Predictions from incumbent systems, scored beside the model through the same scorer. */
  baselines?: Record<string, string | null>;
};

export type GoldRow = {
  itemId: string;
  gold: string;
  goldSource: string;
  labeler?: string;
  /** The first human decision, when it differs from the final one. */
  firstHumanLabel?: string;
};

export type MappedAnswer = {
  /** The node's action label, or null when the model abstained. */
  pred: string | null;
  confidence: number | null;
  abstained: boolean;
};

/**
 * What one question should answer in a training row: a choice option key, a noul boolean, a score
 * level index, or null for "unknown".
 */
export type TrainTarget = string | boolean | number | null;

export type FormatSpec = {
  /** `fromDataDir` loads the questions at run time from a JSON file under --data-dir. */
  questions: readonly DecisionQuestion[] | { fromDataDir: string };
  mapAnswer(answers: readonly NormalizedAnswer[]): MappedAnswer;
  /**
   * The inverse of `mapAnswer` for training: per question id, the answer that gold class should
   * produce, or null when this format cannot express that class. A format without it cannot train.
   */
  trainTargets?(gold: string): Record<string, TrainTarget> | null;
};

/** `refused`: the state failed the PII check, so it was never sent. */
export type PredictionStatus = 'ok' | 'missing' | 'error' | 'refused';

export type Prediction = {
  itemId: string;
  runKey: string;
  status: PredictionStatus;
  pred?: string | null;
  confidence?: number | null;
  abstained?: boolean;
  answers?: NormalizedAnswer[];
  build?: string;
  hardware?: string;
  latencyMs?: number;
  error?: string;
};
