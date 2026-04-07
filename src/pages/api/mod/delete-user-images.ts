import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { searchClient } from '~/server/meilisearch/client';
import { deleteImages, queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { bustCachesForPosts } from '~/server/services/post.service';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
  batchSize: z.coerce.number().default(100),
});

export default ModEndpoint(
  async function deleteUserImages(req: NextApiRequest, res: NextApiResponse) {
    try {
      const { userId, batchSize } = schema.parse(req.query);

      const images = await dbRead.image.findMany({
        where: { userId },
        select: { id: true, postId: true },
      });
      if (images.length === 0) return res.status(200).json({ deletedImages: 0, deletedPosts: 0 });

      const imageIds = images.map((i) => i.id);
      const postIds = [
        ...new Set(images.map((i) => i.postId).filter((id): id is number => id != null)),
      ];

      let deletedImages = 0;
      for (const batch of chunk(imageIds, batchSize)) {
        const result = await deleteImages(batch);
        deletedImages += result.length;
      }

      let deletedPosts = 0;
      if (postIds.length) {
        // Only delete posts owned by the target user to avoid touching other users' posts
        // that may have referenced these images.
        const result = await dbWrite.post.deleteMany({
          where: { userId, id: { in: postIds } },
        });
        deletedPosts = result.count;
      }

      return res.status(200).json({ deletedImages, deletedPosts });
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);

// Cleans up stale image documents in the search index for a given search query.
// Paginates meilisearch, cross-references against the DB, and queues deletes
// for any document whose underlying image row no longer exists.
// queueImageSearchIndexUpdate targets both images_v6 and metrics_images_v1.
// async function deleteDeletedImages(query: string) {
//   if (!searchClient) throw new Error('Search client not available');

//   // Paginate through meilisearch collecting { id, postId } for each hit
//   type MeiliHit = { id: number; postId: number | null };
//   const hits: MeiliHit[] = [];
//   const pageSize = 1000;
//   let offset = 0;
//   while (true) {
//     const results = await searchClient.index(IMAGES_SEARCH_INDEX).search<MeiliHit>(query, {
//       limit: pageSize,
//       offset,
//       attributesToRetrieve: ['id', 'postId'],
//     });
//     if (!results.hits.length) break;
//     hits.push(...results.hits);
//     if (results.hits.length < pageSize) break;
//     offset += pageSize;
//   }

//   if (!hits.length) return { found: 0, orphanedImages: 0, deletedPosts: 0 };

//   // Determine which image IDs are truly orphaned (present in meili but gone from DB)
//   const meiliIds = hits.map((h) => h.id);
//   const existing = await dbRead.image.findMany({
//     where: { id: { in: meiliIds } },
//     select: { id: true },
//   });
//   const existingIds = new Set(existing.map((i) => i.id));
//   const orphanHits = hits.filter((h) => !existingIds.has(h.id));
//   const orphanImageIds = orphanHits.map((h) => h.id);

//   if (orphanImageIds.length) {
//     // queueImageSearchIndexUpdate targets both images_v6 and metrics_images_v1
//     await queueImageSearchIndexUpdate({
//       ids: orphanImageIds,
//       action: SearchIndexUpdateQueueAction.Delete,
//     });
//   }

//   // Find posts referenced by the orphaned images that still exist in DB and are now empty
//   const candidatePostIds = [
//     ...new Set(orphanHits.map((h) => h.postId).filter((id): id is number => id != null)),
//   ];

//   let deletedPosts = 0;
//   if (candidatePostIds.length) {
//     const posts = await dbRead.post.findMany({
//       where: { id: { in: candidatePostIds } },
//       select: { id: true, _count: { select: { images: true } } },
//     });
//     const emptyPostIds = posts.filter((p) => p._count.images === 0).map((p) => p.id);

//     if (emptyPostIds.length) {
//       const result = await dbWrite.post.deleteMany({
//         where: { id: { in: emptyPostIds } },
//       });
//       deletedPosts = result.count;
//       await bustCachesForPosts(emptyPostIds);
//     }
//   }

//   return {
//     found: hits.length,
//     orphanedImages: orphanImageIds.length,
//     deletedPosts,
//   };
// }
