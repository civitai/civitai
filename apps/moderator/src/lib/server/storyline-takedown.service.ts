import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';

export type ReportedStoryline = {
  id: number;
  title: string;
  tosViolation: boolean;
  tosViolationByScan: boolean;
};

/** What each reported storyline looks like now, for the report sheet. */
export async function getReportedStorylines(ids: number[]): Promise<ReportedStoryline[]> {
  if (!ids.length) return [];
  return dbRead
    .selectFrom('Storyline')
    .select(['id', 'title', 'tosViolation', 'tosViolationByScan'])
    .where('id', 'in', ids)
    .execute();
}

/** The storyline a report is about, read from the primary: the moderator is acting on it. */
export async function getReportStorylineId(reportId: number): Promise<number | null> {
  const row = await dbWrite
    .selectFrom('StorylineReport')
    .select('storylineId')
    .where('reportId', '=', reportId)
    .executeTakeFirst();
  return row?.storylineId ?? null;
}

/**
 * The main app's `setStorylineTakedown`, for the report queue. A takedown is marked as a
 * moderator's (`tosViolationByScan` false) even over the title scan's, so a clean rescan of the
 * title cannot lift it. A restore clears only a moderator's takedown: one the scan made is lifted
 * for the title a moderator reviewed, which this does not do, so it is left in place and returned.
 *
 * Null when the storyline no longer exists.
 */
export async function setStorylineTakedown({
  storylineId,
  takenDown,
  moderatorId,
}: {
  storylineId: number;
  takenDown: boolean;
  moderatorId: number;
}): Promise<ReportedStoryline | null> {
  const update = takenDown
    ? dbWrite
        .updateTable('Storyline')
        .set({ tosViolation: true, tosViolationByScan: false })
        .where('id', '=', storylineId)
    : dbWrite
        .updateTable('Storyline')
        .set({ tosViolation: false })
        .where('id', '=', storylineId)
        .where('tosViolationByScan', '=', false);
  const { numUpdatedRows } = await update.executeTakeFirst();

  const storyline = await dbWrite
    .selectFrom('Storyline')
    .select(['id', 'title', 'tosViolation', 'tosViolationByScan'])
    .where('id', '=', storylineId)
    .executeTakeFirst();
  if (!storyline) return null;

  if (numUpdatedRows > 0n)
    await recordModActivity({
      userId: moderatorId,
      entityType: 'storyline',
      entityId: storylineId,
      activity: takenDown ? 'takedown' : 'restore',
    });
  return storyline;
}
