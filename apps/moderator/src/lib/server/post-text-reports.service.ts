import { sql } from '@civitai/db/kysely';
import type { PostTextAction, ReportedPostText } from '$lib/post-text-report';
import { dbWrite } from './db';
import { htmlToText } from './html-to-text';
import { callModEndpoint } from './user-actions.service';

/**
 * The texts these reports are about, keyed by report id; a report not on a text is absent. Read on
 * the primary, so a refusal or hold just made shows on the reload. A text since deleted is listed
 * with nulls: its report still sits in the post queue.
 */
export async function getReportedPostTexts(
  reportIds: number[]
): Promise<Map<number, ReportedPostText>> {
  const ids = [...new Set(reportIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();

  const rows = await dbWrite
    .selectFrom('PostTextReport as r')
    .leftJoin('PostText as t', 't.id', 'r.postTextId')
    .innerJoin('Report as rep', 'rep.id', 'r.reportId')
    .select([
      'r.reportId',
      'r.postTextId as textId',
      't.content',
      sql<string | null>`rep.details -> 'postText' ->> 'content'`.as('reportedContent'),
      't.refused',
      't.refusedByModerator',
      't.refusedByScan',
      sql<boolean | null>`t."csamHeld" OR EXISTS (SELECT 1 FROM "TextScanHold" th
        WHERE th."entityType" = 'PostText' AND th."entityId" = t.id AND th.label = 'csam'
          AND th.status IN ('Pending', 'Confirmed'))`.as('held'),
      // Images sort before texts at an equal index, then texts by id (the reader's order).
      sql<number | null>`CASE WHEN t.id IS NULL THEN NULL ELSE 1
        + (SELECT count(*)::int FROM "Image" i WHERE i."postId" = t."postId" AND i."index" <= t."index")
        + (SELECT count(*)::int FROM "PostText" o WHERE o."postId" = t."postId"
            AND (o."index" < t."index" OR (o."index" = t."index" AND o.id < t.id))) END`.as(
        'position'
      ),
      sql<number | null>`CASE WHEN t.id IS NULL THEN NULL ELSE
        (SELECT count(*)::int FROM "Image" i WHERE i."postId" = t."postId")
        + (SELECT count(*)::int FROM "PostText" o WHERE o."postId" = t."postId") END`.as(
        'slideCount'
      ),
    ])
    .where('r.reportId', 'in', ids)
    .execute();

  return new Map(
    rows.map((r) => [
      r.reportId,
      {
        textId: r.textId,
        position: r.position,
        slideCount: r.slideCount,
        text: r.content == null ? null : htmlToText(r.content),
        reportedText: r.reportedContent == null ? null : htmlToText(r.reportedContent),
        refused: !!r.refused,
        refusedByModerator: !!r.refusedByModerator,
        refusedByScan: !!r.refusedByScan,
        held: !!r.held,
      },
    ])
  );
}

/** The text a report names, read from its own row: never from the form. */
export async function getReportPostTextId(reportId: number) {
  const row = await dbWrite
    .selectFrom('PostTextReport as r')
    .innerJoin('Report as rep', 'rep.id', 'r.reportId')
    .select(['r.postTextId', 'rep.reason', 'rep.details'])
    .where('r.reportId', '=', reportId)
    .executeTakeFirst();
  return row ?? null;
}

/** The main app makes the write and its audit row; this app resolves the report after. */
export async function moderatePostText(input: {
  textId: number;
  action: PostTextAction;
  reason: string;
  reportId: number;
}): Promise<{ ok: true; changed: boolean; stillRefused: boolean } | { ok: false; error: string }> {
  const result = await callModEndpoint('post-text/moderate', input, 'Moderate text');
  if (!result.ok) {
    // A timeout, dropped socket or server error may come after the main app made the write.
    const mayHaveApplied = !result.requestNeverSent && (result.status ?? 500) >= 500;
    return {
      ok: false,
      error: mayHaveApplied
        ? 'The main app did not answer and the change may have gone through. Reload to check before trying again.'
        : result.error,
    };
  }
  return {
    ok: true,
    changed: result.body.changed === true,
    stillRefused: result.body.stillRefused === true,
  };
}
