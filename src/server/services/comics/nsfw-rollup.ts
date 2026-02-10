import { dbWrite, dbRead } from '~/server/db/client';

/**
 * Recompute chapter nsfwLevel as bitwise OR of all panel image nsfwLevels.
 */
export async function updateChapterNsfwLevel(projectId: number, chapterPosition: number) {
  const result = await dbRead.$queryRawUnsafe<{ level: number }[]>(
    `SELECT COALESCE(bit_or(i."nsfwLevel"), 0) AS level
     FROM "ComicPanel" p
     JOIN "Image" i ON i.id = p."imageId"
     WHERE p."projectId" = $1 AND p."chapterPosition" = $2`,
    projectId,
    chapterPosition
  );
  const level = result[0]?.level ?? 0;
  await dbWrite.comicChapter.update({
    where: { projectId_position: { projectId, position: chapterPosition } },
    data: { nsfwLevel: level },
  });
  return level;
}

/**
 * Recompute project nsfwLevel as bitwise OR of all chapter nsfwLevels.
 */
export async function updateProjectNsfwLevel(projectId: number) {
  const result = await dbRead.$queryRawUnsafe<{ level: number }[]>(
    `SELECT COALESCE(bit_or("nsfwLevel"), 0) AS level
     FROM "ComicChapter"
     WHERE "projectId" = $1`,
    projectId
  );
  const level = result[0]?.level ?? 0;
  await dbWrite.comicProject.update({
    where: { id: projectId },
    data: { nsfwLevel: level },
  });
  return level;
}

/**
 * Full rollup: given a panel, update the chapter then the project.
 */
export async function rollupNsfwFromPanel(panelId: number) {
  const panel = await dbRead.comicPanel.findUnique({
    where: { id: panelId },
    select: { projectId: true, chapterPosition: true },
  });
  if (!panel) return;

  await updateChapterNsfwLevel(panel.projectId, panel.chapterPosition);
  await updateProjectNsfwLevel(panel.projectId);
}
