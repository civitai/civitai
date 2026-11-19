import { logAxiomError } from './axiom';
import { dbWrite } from './db';
import { syncSearchIndexBulk } from './search-index';

/**
 * For this app's writes to an image's minor flag, which no trigger watches: queues the articles whose
 * cover or banner is one of these images, and the comics whose cover is, for an index rewrite, so the
 * document drops a restricted minor cover and takes it back once it is not. Never throws: it runs
 * after the write has committed. A failure is logged with the image ids and that entity type's
 * requeue is dropped; the other is still sent.
 */
export async function queueArticlesForCoverImages(imageIds: number[]): Promise<void> {
  const ids = [...new Set(imageIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;
  await Promise.all([
    requeue('article', ids, () =>
      dbWrite
        .selectFrom('Article')
        .select('id')
        .where((eb) => eb.or([eb('coverId', 'in', ids), eb('bannerId', 'in', ids)]))
        .execute()
    ),
    requeue('comic', ids, () =>
      dbWrite.selectFrom('ComicProject').select('id').where('coverImageId', 'in', ids).execute()
    ),
  ]);
}

async function requeue(
  entityType: 'article' | 'comic',
  imageIds: number[],
  find: () => Promise<{ id: number }[]>
) {
  try {
    const rows = await find();
    // Strict: a refused or failed call throws here, so its log carries the image ids.
    await syncSearchIndexBulk(
      { entityType, entityIds: rows.map((row) => row.id), action: 'update' },
      { strict: true }
    );
  } catch (error) {
    void logAxiomError(error, { name: 'article-cover-reindex', entityType, imageIds });
  }
}
