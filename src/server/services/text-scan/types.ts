import { NsfwLevel } from '~/server/common/enums';

export const TEXT_SCAN_LABELS = ['nsfw', 'poi', 'minor', 'scam', 'csam'] as const;
export type TextScanLabel = (typeof TEXT_SCAN_LABELS)[number];

export const NSFW_LEVEL_NAMES = ['none', 'pg13', 'r', 'x', 'xxx'] as const;
export type NsfwLevelName = (typeof NSFW_LEVEL_NAMES)[number];

export const nsfwLevelFromName: Record<NsfwLevelName, NsfwLevel> = {
  none: NsfwLevel.PG,
  pg13: NsfwLevel.PG13,
  r: NsfwLevel.R,
  x: NsfwLevel.X,
  xxx: NsfwLevel.XXX,
};

export type TextScanEntityType =
  | 'Model'
  | 'Article'
  | 'Post'
  | 'Bounty'
  | 'BountyEntry'
  | 'Challenge'
  | 'ChatMessage'
  | 'Comment'
  | 'CommentV2'
  | 'CommentV3'
  | 'ResourceReview'
  | 'User'
  | 'UserProfile'
  | 'Crucible'
  | 'Collection'
  | 'Storyline'
  | 'ImageCaption'
  | 'ModelRules';

export type TextScanField = { heading: string; text: string | null | undefined };

export type TextScanDeclared = { nsfwLevel?: number; poi?: boolean; minor?: boolean };

export type TextScanSubject = {
  fields: TextScanField[];
  declared: TextScanDeclared;
  /** The account a verdict is about: the owner, or for ChatMessage the window's sender. */
  userId?: number;
  /** Exists but is not public: the scan skips it; every other reader still gets it. */
  notPublic?: boolean;
  meta?: Record<string, unknown>;
};

export type TextScanProfile = {
  entityType: TextScanEntityType;
  labels: TextScanLabel[];
  /** Compared against `subjectTextLength` (raw trimmed field text, no headings). */
  minChars?: number;
  /** Entities that no longer exist are absent from the map; ones that are not public are not. */
  load: (ids: number[]) => Promise<Map<number, TextScanSubject>>;
  /** The subset of `labels` this subject is scanned for; all of them when absent. */
  labelsFor?: (subject: TextScanSubject) => TextScanLabel[];
};

export type TextScanOutput = {
  nsfw?: { level: NsfwLevelName; reason: string };
  poi?: { detected: boolean; names: string[]; reason: string };
  minor?: { detected: boolean; reason: string };
  scam?: { detected: boolean; reason: string };
  csam?: { detected: boolean; reason: string };
};

/** `base` plus one entry per label, each the `TextScanPrompt.id` used. */
export type PromptIds = Record<string, number>;

export type TextScanMode = 'off' | 'shadow' | 'active';

export type NsfwOutcome = {
  detectedLevel: NsfwLevel;
  declaredLevel: number;
  raised: boolean;
  reason: string;
};
export type FlagOutcome = {
  detected: boolean;
  declared: boolean;
  newlyDetected: boolean;
  reason: string;
};
export type PoiOutcome = FlagOutcome & { names: string[] };
export type ScamOutcome = { detected: boolean; reason: string };
export type CsamOutcome = { detected: boolean; reason: string };

export type TextScanOutcome = {
  nsfw?: NsfwOutcome;
  poi?: PoiOutcome;
  minor?: FlagOutcome;
  scam?: ScamOutcome;
  csam?: CsamOutcome;
  triggeredLabels: TextScanLabel[];
  /** The detected level when `nsfw` was requested, else null. Stored on `EntityModeration.nsfwLevel`. */
  nsfwLevel: number | null;
};
