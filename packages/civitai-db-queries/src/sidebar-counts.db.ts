import { sql, type Kysely } from 'kysely';
import type { Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The `Image.needsReview` / `Report.status` values, derived from the schema so this module needs no separate
// enum import.
type ImageNeedsReviewValue = NonNullable<Selectable<DB['Image']>['needsReview']>;
type ReportStatusValue = Selectable<DB['Report']>['status'];

const APPEAL: ImageNeedsReviewValue = 'appeal';
const PENDING: ReportStatusValue = 'Pending';

// The image-tags queue: distinct images carrying a needsReview moderation tag. The bitmask predicates are
// written to match the `TagsOnImageNew_needsReview_idx` partial index exactly (bit 9 set, bit 10 clear).
export async function countPendingImageTagReviews(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom('TagsOnImageNew')
    .select((eb) => eb.fn.count('imageId').distinct().as('count'))
    .where(sql<boolean>`((attributes >> 9)::integer & 1) = 1`)
    .where(sql<boolean>`((attributes >> 10)::integer & 1) <> 1`)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

// The appeals queue: images whose needsReview is 'appeal'. Rides `Image_needsReview_index`.
export async function countImageAppeals(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom('Image')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('needsReview', '=', APPEAL)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

// The reported queue: distinct images with a PENDING report (count per image, not per report). Rides
// `Report_pending_id_idx`.
export async function countReportsPending(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom('Report as r')
    .innerJoin('ImageReport as ir', 'ir.reportId', 'r.id')
    .select((eb) => eb.fn.count('ir.imageId').distinct().as('count'))
    .where('r.status', '=', PENDING)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}
