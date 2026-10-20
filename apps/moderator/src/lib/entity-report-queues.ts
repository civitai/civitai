import { ReportEntity, reportEntitySlugs, reportPath } from './reports';

/**
 * The report types that share one queue route, `/reports/[queue=entityQueue]`: the queue on the left,
 * the reported thing in the middle, the reports and what to do about them on the right — the user,
 * model and post queues' layout, with the middle column picked per type.
 *
 * Users, models, posts and images keep their own routes: their evidence is tabbed or heavy enough to be
 * a page of its own. Every other type stays a `/reports/[slug]` table until it is added here — see
 * `docs/moderator-app/report-queue-pattern.md` for the full list of what adding one takes.
 */
export const ENTITY_QUEUE_TYPES = [
  ReportEntity.Article,
  ReportEntity.Chat,
  ReportEntity.Collection,
  ReportEntity.Bounty,
  ReportEntity.BountyEntry,
] as const;
export type EntityQueueType = (typeof ENTITY_QUEUE_TYPES)[number];

const typeBySlug = new Map<string, EntityQueueType>(
  ENTITY_QUEUE_TYPES.map((t) => [reportEntitySlugs[t], t])
);

/** The `entityQueue` param matcher's rule, and the route's way back from its slug to the type. */
export const entityQueueForSlug = (slug: string): EntityQueueType | undefined =>
  typeBySlug.get(slug);

/** What the queue calls itself and the thing it is about, in the page's own words. */
export const ENTITY_QUEUE_LABELS: Record<EntityQueueType, { title: string; noun: string }> = {
  article: { title: 'Article reports', noun: 'article' },
  chat: { title: 'Chat reports', noun: 'chat' },
  collection: { title: 'Collection reports', noun: 'collection' },
  bounty: { title: 'Bounty reports', noun: 'bounty' },
  bountyEntry: { title: 'Bounty entry reports', noun: 'bounty entry' },
};

/** Why a chat report does or does not name one member — the page says which rather than guessing. */
export type ChatSubjectRule = 'one' | 'mutual' | 'outsider' | 'group';

/** What the chat rule reads off a report: its filer, and everyone folded into it. */
export type ChatReporters = { reportedById: number; alsoReportedBy?: number[] | null };

/**
 * Who a set of chat reports is about — `chatReportSubject`'s rule (`report-entities.ts`), here over
 * the reports a page shows: the OTHER member of a two-person chat a reporter is in. Every reporter
 * counts, the co-reporters in `alsoReportedBy` too — the main app folds a second report into the
 * first, so a DM both members reported is one report naming two reporters, and names nobody.
 *
 * Shared by the queue rows (one report each) and the open chat (every report on screen, resolved ones
 * from a status filter or a `?report=` link included), so the two cannot disagree.
 */
export function chatSubject(
  members: { userId: number }[],
  reports: ChatReporters[]
): { subjectIds: number[]; rule: ChatSubjectRule; reporterIds: number[] } {
  const reporterIds = [
    ...new Set(reports.flatMap((r) => [r.reportedById, ...(r.alsoReportedBy ?? [])])),
  ];
  const reporters = new Set(reporterIds);
  if (members.length !== 2) return { subjectIds: [], rule: 'group', reporterIds };
  if (!members.some((m) => reporters.has(m.userId)))
    return { subjectIds: [], rule: 'outsider', reporterIds };
  const subjectIds = members.filter((m) => !reporters.has(m.userId)).map((m) => m.userId);
  return { subjectIds, rule: subjectIds.length === 1 ? 'one' : 'mutual', reporterIds };
}

/** One wording for an entry, in the queue row and the open item's header alike. */
export const entryTitle = (id: number, bountyName: string | null | undefined) =>
  `Entry #${id}${bountyName ? ` on ${bountyName}` : ''}`;

/** The queue opened on one reported item — the item in the path, as on the post queue. */
export const entityReportUrl = (type: EntityQueueType, id: number) => `${reportPath(type)}/${id}`;

/**
 * One queue row's subject: what was reported, and whose it is. One shape for every type so the queue
 * column is one component; the types differ in where each field comes from, not in what the row says.
 */
export type QueueSubject = {
  title: string;
  /** The account the report is about — the owner, or for a chat the other member (see the chat read). */
  userId: number | null;
  username: string | null;
  bannedAt: Date | null;
  /** One line of what a moderator scans the queue for: a status, a size. */
  note: string | null;
};
