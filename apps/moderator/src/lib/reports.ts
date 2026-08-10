import { ReportReason, ReportStatus } from '@civitai/db-schema/enums';

export { ReportReason, ReportStatus };

export const ReportEntity = {
  Model: 'model',
  Comment: 'comment',
  CommentV2: 'commentV2',
  Image: 'image',
  ResourceReview: 'resourceReview',
  Article: 'article',
  Post: 'post',
  User: 'reportedUser',
  Collection: 'collection',
  Bounty: 'bounty',
  BountyEntry: 'bountyEntry',
  Chat: 'chat',
  ComicProject: 'comicProject',
  Model3D: 'model3d',
  Model3DReview: 'model3dReview',
} as const;
export type ReportEntity = (typeof ReportEntity)[keyof typeof ReportEntity];

export const reportEntities = Object.values(ReportEntity);
export const reportStatuses = Object.values(ReportStatus);
export const reportReasons = Object.values(ReportReason);

export const reportReasonLabels: Record<ReportReason, string> = {
  TOSViolation: 'TOS Violation',
  NSFW: 'NSFW',
  Ownership: 'Ownership',
  AdminAttention: 'Admin Attention',
  Claim: 'Claim',
  CSAM: 'CSAM',
  Automated: 'Automated',
  Spam: 'Spam',
  StickerPlacement: 'Sticker Placement',
};

export const DEFAULT_REPORT_REASONS: ReportReason[] = [
  ReportReason.AdminAttention,
  ReportReason.Claim,
  ReportReason.Ownership,
  ReportReason.TOSViolation,
  ReportReason.Spam,
];

export const DEFAULT_REPORT_STATUSES: ReportStatus[] = [
  ReportStatus.Pending,
  ReportStatus.Processing,
];

export const reportEntityLabels: Record<ReportEntity, string> = {
  model: 'Model',
  comment: 'Model Comment',
  commentV2: 'Comment',
  image: 'Image',
  resourceReview: 'Review',
  article: 'Article',
  post: 'Post',
  reportedUser: 'User',
  collection: 'Collection',
  bounty: 'Bounty',
  bountyEntry: 'Bounty Entry',
  chat: 'Chat',
  comicProject: 'Comic',
  model3d: '3D Model',
  model3dReview: '3D Review',
};

// URL segment for each entity's report page. Part of shareable URLs and of the nav paths that grants match
// against — renaming one breaks saved links, so extend rather than reshuffle.
export const reportEntitySlugs: Record<ReportEntity, string> = {
  model: 'model',
  comment: 'model-comment',
  commentV2: 'comment',
  image: 'image',
  resourceReview: 'review',
  article: 'article',
  post: 'post',
  reportedUser: 'user',
  collection: 'collection',
  bounty: 'bounty',
  bountyEntry: 'bounty-entry',
  chat: 'chat',
  comicProject: 'comic',
  model3d: '3d-model',
  model3dReview: '3d-review',
};

const entityBySlug = new Map(
  Object.entries(reportEntitySlugs).map(([entity, slug]) => [slug, entity as ReportEntity])
);

export const reportEntityForSlug = (slug: string): ReportEntity | undefined =>
  entityBySlug.get(slug);

export const reportPath = (entity: ReportEntity) => `/reports/${reportEntitySlugs[entity]}`;

export const reportCountKey = (entity: ReportEntity) => `report:${entity}`;

/** `Report.details` is jsonb. Retool's CASE picked `violation` over `reason` and showed `comment`
 *  separately — the comment is the reporter's own words, and is the only part that says what actually
 *  happened. Every page that renders a report should show it; several fetched it and dropped it. */
export const reportDetail = (details: unknown, key: string): string | undefined =>
  details && typeof details === 'object'
    ? ((details as Record<string, unknown>)[key] as string | undefined)
    : undefined;

/** The label Retool showed for a report: the violation, else the stated reason, else the enum. */
export const reportReasonLabel = (details: unknown, reason: string): string =>
  reportDetail(details, 'violation') ?? reportDetail(details, 'reason') ?? reason;

export const reportStatusBadgeClass: Record<ReportStatus, string> = {
  Pending: 'bg-yellow-500/15 text-yellow-300',
  Processing: 'bg-orange-500/15 text-orange-300',
  Actioned: 'bg-red-500/15 text-red-300',
  Unactioned: 'bg-green-500/15 text-green-300',
};

// The `Badge` equivalent of the classes above, for the pages that render a primitive rather than a
// styled span. Three routes had inline ternaries that already disagreed — a Pending report was a filled
// badge in User Lookup and a muted one in Chat Audit and Image Lookup.
export function reportStatusVariant(status: string): 'default' | 'secondary' | 'destructive' {
  if (status === 'Actioned') return 'destructive';
  if (status === 'Unactioned') return 'secondary';
  // Pending and Processing are the OPEN states — the ones still wanting a decision.
  return 'default';
}

// Only id-URL-clean types are linkable; the rest return null until their richer URL shapes are ported.
const entityPath: Partial<Record<ReportEntity, (id: number) => string>> = {
  model: (id) => `/models/${id}`,
  image: (id) => `/images/${id}`,
  article: (id) => `/articles/${id}`,
  post: (id) => `/posts/${id}`,
  collection: (id) => `/collections/${id}`,
  bounty: (id) => `/bounties/${id}`,
  resourceReview: (id) => `/reviews/${id}`,
  comicProject: (id) => `/comics/${id}`,
  model3d: (id) => `/3d-models/${id}`,
};

export function getReportItemUrl(
  base: string,
  type: ReportEntity,
  entityId: number | null
): string | null {
  if (entityId == null) return null;
  const path = entityPath[type]?.(entityId);
  return path ? `${base}${path}` : null;
}
