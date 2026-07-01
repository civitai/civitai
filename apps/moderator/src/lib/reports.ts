import { ReportReason, ReportStatus } from '@civitai/db-schema/enums';

// Enums are the shared canonical contract; ReportEntity (which join table a report points through) is
// moderator-only, so it's re-authored here rather than shared.
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
};

// The manual-review default view — reasons a moderator triages by hand (excludes NSFW/CSAM/Automated).
export const DEFAULT_REPORT_REASONS: ReportReason[] = [
  ReportReason.AdminAttention,
  ReportReason.Claim,
  ReportReason.Ownership,
  ReportReason.TOSViolation,
  ReportReason.Spam,
];

export const reportEntityLabels: Record<ReportEntity, string> = {
  model: 'Model',
  comment: 'Comment',
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

export const reportStatusBadgeClass: Record<ReportStatus, string> = {
  Pending: 'bg-yellow-500/15 text-yellow-300',
  Processing: 'bg-orange-500/15 text-orange-300',
  Actioned: 'bg-red-500/15 text-red-300',
  Unactioned: 'bg-green-500/15 text-green-300',
};

// Absolute (reported items live on the main site). Only id-URL-clean types are linkable; the rest
// (comment threads, chat, user, bounty entries) return null until their richer URL shapes are ported.
const CIVITAI_URL = 'https://civitai.com';
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

export function getReportItemUrl(type: ReportEntity, entityId: number | null): string | null {
  if (entityId == null) return null;
  const path = entityPath[type]?.(entityId);
  return path ? `${CIVITAI_URL}${path}` : null;
}
