import { dbWrite } from '~/server/db/client';

/**
 * Project-row writes for chapters that just went live, shared by `publishChapter` and the
 * scheduled-publish job. The comics Newest feed orders by project `updatedAt`, so it is bumped
 * here; `publishedAt` is set only on a project's first-ever publish.
 */
export async function markComicProjectsChapterPublished(projectIds: number[], now = new Date()) {
  if (!projectIds.length) return;
  await dbWrite.comicProject.updateMany({
    where: { id: { in: projectIds } },
    data: { updatedAt: now },
  });
  await dbWrite.comicProject.updateMany({
    where: { id: { in: projectIds }, publishedAt: null },
    data: { publishedAt: now },
  });
}
