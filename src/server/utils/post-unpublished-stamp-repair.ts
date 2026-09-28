export type StampedPostRow = {
  id: number;
  publishedAt: Date;
  unpublishedAt: Date;
  userId: number;
  modelVersionId: number | null;
  versionStatus: string | null;
  modelStatus: string | null;
  modelUserId: number | null;
};

export const BUCKETS = ['orphan', 'republished', 'liveParent', 'detached', 'equal'] as const;
export type Bucket = (typeof BUCKETS)[number];
export type RepairAction = 'clear' | 'strip' | 'skip';
export type UndecidedAction = RepairAction;

const PUBLISHED = 'Published';

export function classifyStampedPost(row: StampedPostRow): Bucket {
  const published = row.publishedAt.getTime();
  const unpublished = row.unpublishedAt.getTime();
  if (unpublished < published) return 'republished';
  if (unpublished === published) return 'equal';
  // Every unpublish cascade is scoped to the model owner's posts on the model's versions, so a
  // post outside that scope has no parent whose state could say what it should be.
  if (row.modelVersionId == null || row.modelUserId == null || row.modelUserId !== row.userId)
    return 'detached';
  // The republish cascade skips posts that still have a publishedAt, so a post the old path
  // stamped without clearing kept its stamp when the model came back.
  if (row.versionStatus === PUBLISHED && row.modelStatus === PUBLISHED) return 'liveParent';
  return 'orphan';
}

export type RepairPlan = {
  buckets: Record<Bucket, number[]>;
  clear: number[];
  strip: number[];
  skipped: number[];
};

export function planRepair(
  rows: StampedPostRow[],
  undecided: { liveParent: UndecidedAction; detached: UndecidedAction }
): RepairPlan {
  const actionOf: Record<Bucket, RepairAction> = {
    orphan: 'clear',
    republished: 'strip',
    liveParent: undecided.liveParent,
    detached: undecided.detached,
    equal: 'skip',
  };
  const buckets: Record<Bucket, number[]> = {
    orphan: [],
    republished: [],
    liveParent: [],
    detached: [],
    equal: [],
  };
  const plan: RepairPlan = { buckets, clear: [], strip: [], skipped: [] };
  for (const row of rows) {
    const bucket = classifyStampedPost(row);
    buckets[bucket].push(row.id);
    const action = actionOf[bucket];
    if (action === 'clear') plan.clear.push(row.id);
    else if (action === 'strip') plan.strip.push(row.id);
    else plan.skipped.push(row.id);
  }
  return plan;
}
