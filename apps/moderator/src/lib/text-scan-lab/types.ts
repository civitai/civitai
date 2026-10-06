export const LAB_ENTITY_TYPES = [
  'Model',
  'Article',
  'Post',
  'Bounty',
  'BountyEntry',
  'Challenge',
  'Crucible',
  'Collection',
  'ChatMessage',
  'Comment',
  'CommentV2',
  'ResourceReview',
  'User',
  'UserProfile',
] as const;
export type LabEntityType = (typeof LAB_ENTITY_TYPES)[number];

export type LabLabel = 'nsfw' | 'poi' | 'minor' | 'scam';

// Mirrors each main-app profile's `labels` (src/server/services/text-scan/profiles/*.profile.ts).
export const LAB_LABELS: Record<LabEntityType, readonly LabLabel[]> = {
  Model: ['nsfw', 'poi', 'minor'],
  Bounty: ['nsfw', 'poi'],
  Article: ['nsfw'],
  Post: ['nsfw'],
  BountyEntry: ['nsfw'],
  Challenge: ['nsfw'],
  Crucible: ['nsfw'],
  Collection: ['nsfw'],
  ChatMessage: ['scam'],
  Comment: ['scam'],
  CommentV2: ['scam'],
  ResourceReview: ['scam'],
  User: ['scam'],
  UserProfile: ['scam'],
};

// Each profile's first heading, so free text reads to the model like that entity type.
export const DEFAULT_HEADING: Record<LabEntityType, string> = {
  Model: 'Name',
  Article: 'Title',
  Post: 'Title',
  Bounty: 'Name',
  BountyEntry: 'Description',
  Challenge: 'Title',
  Crucible: 'Name',
  Collection: 'Name',
  ChatMessage: 'Messages, newest first',
  Comment: 'Comment',
  CommentV2: 'Comment',
  ResourceReview: 'Review',
  User: 'Username',
  UserProfile: 'Bio',
};

export type LabField = { heading: string; text: string };
export type LabText = { key: string; fields: LabField[] };

export type NsfwLevelName = 'none' | 'pg13' | 'r' | 'x' | 'xxx';

export type Expected = {
  nsfw?: { min: NsfwLevelName; max: NsfwLevelName };
  poi?: boolean;
  minor?: boolean;
  scam?: boolean;
};

export type LabScanResult =
  | {
      key: string;
      ok: true;
      workflowId: string;
      promptIds: Record<string, number>;
      output: Record<string, unknown> | null;
      parseError?: string;
      elapsedMs: number;
    }
  | { key: string; ok: false; error: string };
