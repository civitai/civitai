import { dbWrite, dbRead } from '~/server/db/client';

/**
 * Recompute chapter nsfwLevel as bitwise OR of all panel image nsfwLevels.
 */
export async function updateChapterNsfwLevel(chapterId: string) {
  const result = await dbRead.$queryRawUnsafe<{ level: number }[]>(
    `SELECT COALESCE(bit_or(i."nsfwLevel"), 0) AS level
     FROM "comic_panels" p
     JOIN "Image" i ON i.id = p."imageId"
     WHERE p."chapterId" = $1`,
    chapterId
  );
  const level = result[0]?.level ?? 0;
  await dbWrite.comicChapter.update({
    where: { id: chapterId },
    data: { nsfwLevel: level },
  });
  return level;
}

/**
 * Recompute project nsfwLevel as bitwise OR of all chapter nsfwLevels.
 */
export async function updateProjectNsfwLevel(projectId: string) {
  const result = await dbRead.$queryRawUnsafe<{ level: number }[]>(
    `SELECT COALESCE(bit_or("nsfwLevel"), 0) AS level
     FROM "comic_chapters"
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
export async function rollupNsfwFromPanel(panelId: string) {
  const panel = await dbRead.comicPanel.findUnique({
    where: { id: panelId },
    select: { chapter: { select: { id: true, projectId: true } } },
  });
  if (!panel) return;

  await updateChapterNsfwLevel(panel.chapter.id);
  await updateProjectNsfwLevel(panel.chapter.projectId);
}
