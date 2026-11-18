import { logAxiomError } from './axiom';
import { dbWrite } from './db';
import { syncSearchIndexBulk } from './search-index';

/**
 * For this app's writes to an image's minor flag, which no trigger watches: queues the articles whose
 * cover or banner is one of these images, and the comics whose cover is, for an index rewrite, so the
 * document drops a restricted minor cover and takes it back once it is not. Never throws: it runs after the write has
 * committed. A failure is logged with the image ids and the requeue is dropped.
 */
export async function queueArticlesForCoverImages(imageIds: number[]): Promise<void> {
  const ids = [...new Set(imageIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;
  try {
    const [articles, comics] = await Promise.all([
      dbWrite
        .selectFrom('Article')
        .select('id')
        .where((eb) => eb.or([eb('coverId', 'in', ids), eb('bannerId', 'in', ids)]))
        .execute(),
      dbWrite.selectFrom('ComicProject').select('id').where('coverImageId', 'in', ids).execute(),
    ]);
    await syncSearchIndexBulk({
      entityType: 'article',
      entityIds: articles.map((row) => row.id),
      action: 'update',
    });
    await syncSearchIndexBulk({
      entityType: 'comic',
      entityIds: comics.map((row) => row.id),
      action: 'update',
    });
  } catch (error) {
    void logAxiomError(error, { name: 'article-cover-reindex', imageIds: ids });
  }
}
