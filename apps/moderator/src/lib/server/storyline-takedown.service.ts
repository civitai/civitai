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

export async function getReportedStorylines(ids: number[]): Promise<ReportedStoryline[]> {
  if (!ids.length) return [];
  return dbRead.selectFrom('Storyline').select(columns).where('id', 'in', ids).execute();
}

export type PostStorylineChapter = {
  storylineId: number;
  title: string;
  /** As readers number it along the first-parent route: chapter 1 is depth 0. */
  number: number;
  removed: boolean;
  tosViolation: boolean;
  minorByScan: boolean;
  /** Its owner or author removed it from the storyline while a report was open. */
  heldRemoval: { by: string; at: Date } | null;
};

/**
 * The storyline chapter a post is, or was until its owner or author removed it during an open
 * report. A post is a chapter of at most one storyline.
 */
export async function getPostStorylineChapter(
  postId: number
): Promise<PostStorylineChapter | null> {
  const [row, hold] = await Promise.all([
    dbRead
      .selectFrom('StorylineChapter as c')
      .innerJoin('Storyline as s', 's.id', 'c.storylineId')
      .select(['s.id', 's.title', 's.tosViolation', 's.minorByScan', 'c.depth', 'c.removedAt'])
      .where('c.postId', '=', postId)
      .executeTakeFirst(),
    dbRead
      .selectFrom('StorylineChapterRemovalHold as h')
      .innerJoin('Storyline as s', 's.id', 'h.storylineId')
      .select([
        's.id',
        's.title',
        's.tosViolation',
        's.minorByScan',
        'h.depth',
        'h.removedByRole',
        'h.createdAt',
      ])
      .where('h.postId', '=', postId)
      .orderBy('h.id', 'desc')
      .executeTakeFirst(),
  ]);
  const heldRemoval = hold ? { by: hold.removedByRole, at: hold.createdAt } : null;
  const source = row ?? hold;
  if (!source) return null;
  return {
    storylineId: source.id,
    title: source.title,
    number: source.depth + 1,
    removed: row ? row.removedAt !== null : true,
    tosViolation: source.tosViolation,
    minorByScan: source.minorByScan,
    heldRemoval,
  };
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
 * Mirrors the main app's `setStorylineTakedown`; keep the two in step. Activity is recorded only
 * when the moderator's flag changed. Null when the storyline no longer exists.
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
