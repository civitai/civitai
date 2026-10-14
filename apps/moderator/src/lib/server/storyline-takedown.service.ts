import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';

export type ReportedStoryline = {
  id: number;
  title: string;
  tosViolation: boolean;
  tosViolationByScan: boolean;
  tosViolationByModerator: boolean;
};

const columns = [
  'id',
  'title',
  'tosViolation',
  'tosViolationByScan',
  'tosViolationByModerator',
] as const;

/** What each reported storyline looks like now, for the report sheet. */
export async function getReportedStorylines(ids: number[]): Promise<ReportedStoryline[]> {
  if (!ids.length) return [];
  return dbRead.selectFrom('Storyline').select(columns).where('id', 'in', ids).execute();
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
 * The main app's `setStorylineTakedown`, for the report queue. A moderator's takedown is held
 * apart from the title scan's (`tosViolationByModerator` and `tosViolationByScan`), and the
 * storyline is down while either holds one: a clean rescan cannot lift the moderator's, and a
 * restore cannot lift the scan's. Activity is recorded only when the moderator's flag changed.
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
}): Promise<(ReportedStoryline & { changed: boolean }) | null> {
  const { numUpdatedRows } = await dbWrite
    .updateTable('Storyline')
    .set((eb) =>
      takenDown
        ? { tosViolation: true, tosViolationByModerator: true }
        : { tosViolation: eb.ref('tosViolationByScan'), tosViolationByModerator: false }
    )
    .where('id', '=', storylineId)
    .where('tosViolationByModerator', '=', !takenDown)
    .executeTakeFirst();

  const storyline = await dbWrite
    .selectFrom('Storyline')
    .select(columns)
    .where('id', '=', storylineId)
    .executeTakeFirst();
  if (!storyline) return null;

  const changed = numUpdatedRows > 0n;
  if (changed)
    await recordModActivity({
      userId: moderatorId,
      entityType: 'storyline',
      entityId: storylineId,
      activity: takenDown ? 'takedown' : 'restore',
    });
  return { ...storyline, changed };
}
