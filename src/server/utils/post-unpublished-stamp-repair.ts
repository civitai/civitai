export type StampedPostRow = {
  id: number;
  publishedAt: Date;
  unpublishedAt: Date;
  updatedAt: Date;
  userId: number;
  stampedByOwner: boolean;
  modelVersionId: number | null;
  versionStatus: string | null;
  modelStatus: string | null;
  modelUserId: number | null;
};

export const BUCKETS = [
  'parentDown',
  'detached',
  'liveParent',
  'scheduled',
  'halfLive',
  'ownerEdited',
] as const;
export type Bucket = (typeof BUCKETS)[number];
export type RepairAction = 'clear' | 'strip' | 'skip';
export type BucketActions = {
  liveParent: 'strip' | 'skip';
  scheduled: RepairAction;
  halfLive: RepairAction;
  ownerEdited: RepairAction;
};

const PUBLISHED = 'Published';
const VIOLATION = 'UnpublishedViolation';
const EDIT_TOLERANCE_MS = 5_000;

export function classifyStampedPost(row: StampedPostRow, now: Date): Bucket {
  const ownersPostOnVersion =
    row.modelVersionId != null && row.modelUserId != null && row.modelUserId === row.userId;
  // Ahead of every bucket that can strip: a post under a moderator takedown is only ever cleared.
  if (ownersPostOnVersion && (row.modelStatus === VIOLATION || row.versionStatus === VIOLATION))
    return 'parentDown';

  if (row.publishedAt > now) return 'scheduled';

  if (ownersPostOnVersion && row.versionStatus === PUBLISHED)
    return row.modelStatus === PUBLISHED ? 'liveParent' : 'halfLive';

  // A stamp older than publishedAt is not evidence of a republish: a post that was scheduled
  // when its model came down has one too. Only an edit by the owner afterwards is.
  const stampedBeforePublish = row.unpublishedAt < row.publishedAt;
  const editedAfterStamp =
    row.updatedAt.getTime() > row.unpublishedAt.getTime() + EDIT_TOLERANCE_MS;
  if (stampedBeforePublish && editedAfterStamp && row.stampedByOwner) return 'ownerEdited';

  return ownersPostOnVersion ? 'parentDown' : 'detached';
}

export type RepairPlan = {
  buckets: Record<Bucket, number[]>;
  clear: number[];
  /** Stripped because the parent is live; the write re-checks that it still is. */
  stripLive: number[];
  /** Stripped on the operator's say-so, whatever the parent. */
  stripForced: number[];
  skipped: number[];
};

export function planRepair(rows: StampedPostRow[], actions: BucketActions, now: Date): RepairPlan {
  const actionOf: Record<Bucket, RepairAction> = {
    parentDown: 'clear',
    detached: 'clear',
    ...actions,
  };
  const plan: RepairPlan = {
    buckets: {
      parentDown: [],
      detached: [],
      liveParent: [],
      scheduled: [],
      halfLive: [],
      ownerEdited: [],
    },
    clear: [],
    stripLive: [],
    stripForced: [],
    skipped: [],
  };
  for (const row of rows) {
    const bucket = classifyStampedPost(row, now);
    plan.buckets[bucket].push(row.id);
    const action = actionOf[bucket];
    if (action === 'clear') plan.clear.push(row.id);
    else if (action === 'skip') plan.skipped.push(row.id);
    else if (bucket === 'liveParent') plan.stripLive.push(row.id);
    else plan.stripForced.push(row.id);
  }
  return plan;
}
