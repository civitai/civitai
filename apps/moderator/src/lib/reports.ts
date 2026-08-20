import { ReportReason, ReportStatus } from '@civitai/db-schema/enums';
import { entityUrl } from './entity-url';

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

export const DEFAULT_REPORT_STATUSES: ReportStatus[] = [
  ReportStatus.Pending,
  ReportStatus.Processing,
];

/** What a queue badge counts: reports nobody has picked up. `Processing` is deliberately excluded —
 *  a moderator sets it while investigating an ownership claim, which can run for weeks, so counting it
 *  makes an idle queue read as a growing backlog. The queue page still LANDS on both. */
export const isReportStatus = (v: string): v is ReportStatus =>
  (reportStatuses as readonly string[]).includes(v);

export const NEW_REPORT_STATUSES: ReportStatus[] = [ReportStatus.Pending];

/**
 * The reasons a human queue is for. Every Retool report query carried `reason != 'Automated'` and the
 * port dropped it, which is not a rounding difference: `entity-moderation` files one `Automated` report
 * per Clavata hit, and they outnumber human reports by three to four orders of magnitude in every queue
 * but images (measured on the dev clone, 2026-08-12: model 238,531 automated to 90 human, chat 52,777 to
 * 1). So every badge read as a five-figure backlog of work nobody does from this page, and that is what
 * made the real single-digit numbers invisible.
 *
 * Hidden, not unreachable — `Automated` stays in the reason filter, so asking for them is one click.
 */
export const DEFAULT_REPORT_REASONS: ReportReason[] = reportReasons.filter(
  (r) => r !== ReportReason.Automated
);

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

export const reportActionPath = (entity: ReportEntity, reportId: number) =>
  `${reportPath(entity)}?report=${reportId}`;

export const reportCountKey = (entity: ReportEntity) => `report:${entity}`;

/** `Report.details` is jsonb. Retool's CASE picked `violation` over `reason` and showed `comment`
 *  separately — the comment is the reporter's own words, and is the only part that says what actually
 *  happened. Every page that renders a report should show it; several fetched it and dropped it. */
export const reportDetail = (details: unknown, key: string): string | undefined =>
  details && typeof details === 'object'
    ? ((details as Record<string, unknown>)[key] as string | undefined)
    : undefined;

/**
 * The placement a `StickerPlacement` report is about, or null.
 *
 * `details` is untyped jsonb and the reporting form coerces `placementId` from a radio value, so it
 * arrives as either a number or its string — main's `getReportedPlacementId` handles both and this
 * matches it. Guarded on the reason as well: a `placementId` in some other report's details is not a
 * licence to offer a takedown button.
 */
export const reportedPlacementId = (details: unknown, reason: string): number | null => {
  if (reason !== ReportReason.StickerPlacement) return null;
  // Read directly rather than through `reportDetail`, which casts to `string` — that cast is fine for
  // the prose fields it was written for and wrong for a value that is genuinely sometimes a number.
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const raw = (details as Record<string, unknown>).placementId;
  const id = typeof raw === 'string' ? Number(raw) : raw;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
};

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
/** One map for "where does this entity live" — see `$lib/entity-url`. The private copy here knew four
 *  segments that one did not, so the same report linked on /reports and rendered dead in User Lookup.
 *
 *  A chat has no public page at all, so `entityUrl` correctly returns null for it and the row rendered
 *  with nothing to click — the reported conversation was only reachable by pasting its id into Chat
 *  Audit by hand. The transcript IS the destination; it just lives in this app rather than on the site. */
export const getReportItemUrl = (
  base: string,
  type: ReportEntity,
  entityId: number | null,
  /** Site-relative path resolved server-side for entities with no page of their own — comments hang
   *  off a parent, so their URL cannot be derived from the entity id alone. */
  contextUrl?: string | null
) =>
  type === 'chat'
    ? entityId
      ? `/retool/chat-audit/chats?chat=${entityId}`
      : null
    : contextUrl
    ? `${base}${contextUrl}`
    : entityUrl(base, type, entityId);
