import { sql } from 'kysely';
import { dbWrite } from '~/server/db/client';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { trackModActivity } from '~/server/services/moderator.service';
import { updatePostNsfwLevels } from '~/server/services/nsfwLevels.service';
import { CSAM_HOLD_TEXT_CHARS, lockCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { postTextTextScanSubject } from '~/server/services/text-scan/profiles/post-text.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { composeUserText } from '~/server/services/text-scan/segment';
import { sanitizeForPostgres } from '~/utils/string-helpers';

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
  | { ok: true; postId: number; changed: boolean }
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
    // `updatedAt` is when its words last changed, which a refusal does not.
    .set({ refused: true, refusedByModerator: true, updatedAt: sql`t."updatedAt"` })
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
  // A refused text no longer rates its post.
  await updatePostNsfwLevels([updated.postId]);
  return { ok: true, postId: updated.postId, changed: true };
}

/**
 * Lifts a moderator's refusal, unless the text is held for csam review or kept by a CSAM report:
 * those are decided in the CSAM queue, never here. Checked in the same statement as the write, so a
 * hold raised meanwhile still refuses it. A refusal the scan made is lifted with it.
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
    .set({ refused: false, refusedByModerator: false, updatedAt: sql`t."updatedAt"` })
    .where('t.id', '=', textId)
    .where('t.refusedByModerator', '=', true)
    .where(restorableText)
    .returning('t.postId')
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
  return { ok: true, postId: updated.postId, changed: true };
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
  const result = await dbWrite.$transaction(async (tx) => {
    await lockCsamHold(tx, 'PostText', textId);
    const text = await tx.postText.findUnique({
      where: { id: textId },
      select: { postId: true, userId: true, content: true },
    });
    if (!text) return null;

    const pending = await tx.textScanHold.findFirst({
      where: { entityType: 'PostText', entityId: textId, label: 'csam', status: 'Pending' },
      select: { id: true },
    });
    let holdId = pending?.id;
    if (!holdId) {
      const subject = postTextTextScanSubject(text);
      const hold = await tx.textScanHold.create({
        data: {
          entityType: 'PostText',
          entityId: textId,
          label: 'csam',
          textHash: textScanTextHash(subject),
          userId: text.userId > 0 ? text.userId : null,
          text: sanitizeForPostgres(composeUserText(subject).slice(0, CSAM_HOLD_TEXT_CHARS)),
          reason: reportId ? `Moderator hold from report #${reportId}` : 'Moderator hold',
          meta: { kind: 'moderator', moderatorId, ...(reportId ? { reportId } : {}) },
        },
        select: { id: true },
      });
      holdId = hold.id;
    }
    await tx.postText.update({
      where: { id: textId },
      data: { csamHeld: true },
      select: { id: true },
    });
    if (!pending)
      await trackModActivity(
        moderatorId,
        { entityType: 'postText', entityId: textId, activity: 'csamHold' },
        tx
      );
    return { postId: text.postId, holdId, changed: !pending };
  });
  return result;
}
