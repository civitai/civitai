import { sql } from 'kysely';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { trackModActivity } from '~/server/services/moderator.service';
import { updatePostNsfwLevels } from '~/server/services/nsfwLevels.service';
import {
  csamHoldLockKey,
  pendingCsamHoldFields,
} from '~/server/services/text-scan/actions/csam-hold';
import { postTextTextScanSubject } from '~/server/services/text-scan/profiles/post-text.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';

/**
 * Whether text `t` may be restored: no csam flag, no csam hold Pending or Confirmed on it, and nothing
 * `post_text_held` holds it for (a CSAM report naming its author or quoting its post, an evidence hold).
 */
const restorableText = sql<boolean>`NOT t."csamHeld"
  AND NOT EXISTS (SELECT 1 FROM "TextScanHold" th
    WHERE th."entityType" = 'PostText' AND th."entityId" = t.id AND th.label = 'csam'
      AND th.status IN ('Pending', 'Confirmed'))
  AND NOT post_text_held(t.id, t."csamHeld", t."postId", t."userId")`;

export type PostTextModerationResult =
  | { ok: true; postId: number; changed: boolean; stillRefused?: boolean }
  | { ok: false; postId: number; error: 'held' };

/**
 * A moderator's refusal of one text: hidden from every reader, as a scan refusal is, until a
 * moderator restores it. The row and the rest of its post are left as they are. Null when the text
 * is gone; `changed: false` when a moderator had already refused it.
 */
export async function refusePostText({
  textId,
  moderatorId,
}: {
  textId: number;
  moderatorId: number;
}): Promise<PostTextModerationResult | null> {
  const updated = await kyselyWrite
    .updateTable('PostText as t')
    // With no moderator refusal, `refused` is the scan's: kept in `refusedByScan` for a restore.
    // `updatedAt` is when its words last changed, which a refusal does not.
    .set({
      refusedByScan: sql`t.refused`,
      refused: true,
      refusedByModerator: true,
      updatedAt: sql`t."updatedAt"`,
    })
    .where('t.id', '=', textId)
    .where('t.refusedByModerator', '=', false)
    .returning('t.postId')
    .executeTakeFirst();
  if (!updated) return unchanged(textId);

  await trackModActivity(moderatorId, {
    entityType: 'postText',
    entityId: textId,
    activity: 'refuse',
  });
  await updatePostNsfwLevels([updated.postId]);
  return { ok: true, postId: updated.postId, changed: true };
}

/**
 * Lifts a moderator's refusal, unless the text is held for csam review or kept by a CSAM report:
 * those are decided in the CSAM queue, never here. Checked in the same statement as the write, so a
 * hold raised meanwhile still refuses it. A refusal the scan made stands (`stillRefused`).
 */
export async function restorePostText({
  textId,
  moderatorId,
}: {
  textId: number;
  moderatorId: number;
}): Promise<PostTextModerationResult | null> {
  const updated = await kyselyWrite
    .updateTable('PostText as t')
    .set({
      refused: sql`t."refusedByScan"`,
      refusedByScan: false,
      refusedByModerator: false,
      updatedAt: sql`t."updatedAt"`,
    })
    .where('t.id', '=', textId)
    .where('t.refusedByModerator', '=', true)
    .where(restorableText)
    .returning(['t.postId', 't.refused'])
    .executeTakeFirst();
  if (!updated) {
    const row = await kyselyWrite
      .selectFrom('PostText as t')
      .select(['t.postId', 't.refusedByModerator', restorableText.as('restorable')])
      .where('t.id', '=', textId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.refusedByModerator && !row.restorable)
      return { ok: false, postId: row.postId, error: 'held' };
    return { ok: true, postId: row.postId, changed: false };
  }

  await trackModActivity(moderatorId, {
    entityType: 'postText',
    entityId: textId,
    activity: 'restore',
  });
  await updatePostNsfwLevels([updated.postId]);
  return { ok: true, postId: updated.postId, changed: true, stillRefused: updated.refused };
}

async function unchanged(textId: number): Promise<PostTextModerationResult | null> {
  const row = await kyselyWrite
    .selectFrom('PostText')
    .select('postId')
    .where('id', '=', textId)
    .executeTakeFirst();
  return row ? { ok: true, postId: row.postId, changed: false } : null;
}

/**
 * A second writer of pending csam holds beside the scan's `writePendingHold`: the lock key and the
 * row's author and text come from csam-hold.ts (`csamHoldLockKey`, `pendingCsamHoldFields`); only the
 * policy on existing holds differs.
 *
 * Sends a reported text to the CSAM text-hold queue: a Pending csam hold on its current words, and
 * `csamHeld` set, which hides it from every reader and keeps it from being edited or deleted until
 * the hold is decided there. A text with a pending hold already is left in it (`changed: false`).
 * Unlike a scan's detection, a moderator's hold is raised even on words an earlier hold dismissed.
 */
export async function holdPostTextForCsam({
  textId,
  moderatorId,
  reportId,
}: {
  textId: number;
  moderatorId: number;
  reportId?: number;
}): Promise<{ postId: number; holdId: number; changed: boolean } | null> {
  const result = await kyselyWrite.transaction().execute(async (trx) => {
    // The scan's hold writer and a decision take the same lock (`lockCsamHold`).
    await sql`SELECT pg_advisory_xact_lock(hashtext(${csamHoldLockKey(
      'PostText'
    )}), ${textId}::int)`.execute(trx);
    const text = await trx
      .selectFrom('PostText')
      .select(['postId', 'userId', 'content'])
      .where('id', '=', textId)
      .executeTakeFirst();
    if (!text) return null;

    const pending = await trx
      .selectFrom('TextScanHold')
      .select('id')
      .where('entityType', '=', 'PostText')
      .where('entityId', '=', textId)
      .where('label', '=', 'csam')
      .where('status', '=', 'Pending')
      .executeTakeFirst();
    let holdId = pending?.id;
    if (!holdId) {
      const subject = postTextTextScanSubject(text);
      const reported = reportId ? await reportedWords(trx, reportId, textId) : null;
      // The hold is on the words the text has now (its hash is what a decision checks); the words as
      // reported, when the author has changed them since, are held beside them for the reviewer.
      const shown =
        reported != null && reported !== text.content
          ? {
              ...subject,
              fields: [
                ...subject.fields,
                {
                  heading: 'As reported',
                  text: postTextTextScanSubject({ ...text, content: reported }).fields[0].text,
                },
              ],
            }
          : subject;
      const meta = { kind: 'moderator', moderatorId, ...(reportId ? { reportId } : {}) };
      const hold = await trx
        .insertInto('TextScanHold')
        .values({
          entityType: 'PostText',
          entityId: textId,
          label: 'csam',
          textHash: textScanTextHash(subject),
          ...pendingCsamHoldFields(shown),
          reason: reportId ? `Moderator hold from report #${reportId}` : 'Moderator hold',
          meta: sql`${JSON.stringify(meta)}::jsonb`,
          updatedAt: sql`now()`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      holdId = hold.id;
    }
    await trx.updateTable('PostText').set({ csamHeld: true }).where('id', '=', textId).execute();
    return { postId: text.postId, holdId, changed: !pending };
  });
  if (result?.changed)
    await trackModActivity(moderatorId, {
      entityType: 'postText',
      entityId: textId,
      activity: 'csamHold',
    });
  return result;
}

/** The reason a report on this text gives, or null when the report is not on this text. */
export async function getPostTextReportReason(reportId: number, textId: number) {
  const row = await kyselyWrite
    .selectFrom('PostTextReport as r')
    .innerJoin('Report as rep', 'rep.id', 'r.reportId')
    .select(['rep.reason', 'rep.details'])
    .where('r.reportId', '=', reportId)
    .where('r.postTextId', '=', textId)
    .executeTakeFirst();
  return row ?? null;
}

/** The words a report on this text snapshotted when it was filed (`createReport`), or null. */
async function reportedWords(
  db: Pick<typeof kyselyWrite, 'selectFrom'>,
  reportId: number,
  textId: number
) {
  const row = await db
    .selectFrom('PostTextReport as r')
    .innerJoin('Report as rep', 'rep.id', 'r.reportId')
    .select(sql<string | null>`rep.details -> 'postText' ->> 'content'`.as('content'))
    .where('r.reportId', '=', reportId)
    .where('r.postTextId', '=', textId)
    .executeTakeFirst();
  return row?.content ?? null;
}
