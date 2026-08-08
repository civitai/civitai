import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import type { MediaType } from '$lib/media/edge-url';
import type { Capped } from './user-account.service';

// The suspect's own content, for reviewing a report against an account without leaving the queue
// (Retool's TOSImages + GetImageCount).
//
// The queue itself is NOT here: it is `getReports({ type: ReportEntity.User })` in reports.service.ts.
// A parallel query was written first and had already diverged from `getReportCounts` on which reasons
// it excludes, so the sidebar badge and the page heading disagreed about the same queue.

export type SuspectImage = {
  id: number;
  url: string;
  /** `type` and `name` both feed media-type inference. Without them every video renders through the
   *  image pipeline, in a grid whose whole purpose is judging what this account posted. */
  type: MediaType;
  name: string | null;
  nsfwLevel: number;
  createdAt: Date;
  postId: number | null;
  tosViolation: boolean;
  needsReview: string | null;
};

export async function getSuspectImages(
  userId: number,
  limit = 60
): Promise<Capped<SuspectImage> & { total: number; blocked: number }> {
  const [rows, counts] = await Promise.all([
    dbRead
      .selectFrom('Image')
      .select([
        'id',
        'url',
        'type',
        'name',
        'nsfwLevel',
        'createdAt',
        'postId',
        'tosViolation',
        'needsReview',
      ])
      .where('userId', '=', userId)
      .where('ingestion', '!=', 'Blocked')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute(),
    // Retool's GetImageCount counted everything, blocked included, and showed the blocked ones — that
    // is prior enforcement, and a moderator deciding whether to ban wants to see it.
    //
    // The grid still hides them (they cannot be reviewed), so the two numbers are reported separately.
    // A single blended total is what produces "184 images" above "no reviewable images" on the
    // accounts where a colleague has already removed everything — which reads as a broken panel.
    dbRead
      .selectFrom('Image')
      .select((eb) => [
        eb.fn.countAll<string>().as('total'),
        eb.fn.count<string>(sql`case when "ingestion" = 'Blocked' then 1 end`).as('blocked'),
      ])
      .where('userId', '=', userId)
      .executeTakeFirst(),
  ]);

  return {
    items: rows.slice(0, limit) as unknown as SuspectImage[],
    truncated: rows.length > limit,
    total: Number(counts?.total ?? 0),
    blocked: Number(counts?.blocked ?? 0),
  };
}
