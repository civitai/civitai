import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { searchClient } from '~/server/meilisearch/client';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Reaps documents in the images index whose Image row no longer exists — the images
 * index is reconciled by nothing (`CLEANUP_INDEXES` in meilisearch/cleanup.ts omits it),
 * so a delete lost to a degraded sysRedis enqueue leaves a document that renders as a
 * broken tile forever.
 *
 * Scoped to a query or filter on purpose. A full sweep of the index is ~6.4K keyset
 * pages at 6-16s each against a 891GB LMDB, which evicts the live search working set;
 * the damage is concentrated (a bulk deletion orphans one cohort, so one search comes
 * back a quarter broken while its neighbours are clean), so reaping the affected query
 * costs a few seconds and fixes what anyone actually sees.
 *
 *   ?query=<text>          text search to sweep (default: empty = browse order)
 *   ?filter=<meili filter> e.g. user.username = "someone"
 *   ?limit=<n>             docs to examine, max 20000 (default 2000)
 *   ?dryRun=false          actually queue the deletes (default true)
 *   ?maxOrphanRate=<0-1>   abort above this fraction (default 0.5)
 */
const schema = z.object({
  query: z.string().default(''),
  filter: z.string().optional(),
  limit: z.coerce.number().min(1).max(20000).default(2000),
  dryRun: booleanString().default(true),
  maxOrphanRate: z.coerce.number().min(0).max(1).default(0.5),
});

const PAGE_SIZE = 1000;
const DB_CHUNK_SIZE = 2000;

export default ModEndpoint(
  async function cleanupOrphanedSearchDocs(req: NextApiRequest, res: NextApiResponse) {
    try {
      const { query, filter, limit, dryRun, maxOrphanRate } = schema.parse(req.query);
      if (!searchClient) throw new Error('Search client not available');

      const index = searchClient.index(IMAGES_SEARCH_INDEX);
      const indexed: number[] = [];
      for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
        const page = await index.search<{ id: number }>(query, {
          limit: Math.min(PAGE_SIZE, limit - offset),
          offset,
          filter,
          attributesToRetrieve: ['id'],
        });
        indexed.push(...page.hits.map((hit) => hit.id));
        if (page.hits.length < PAGE_SIZE) break;
      }
      if (!indexed.length) return res.status(200).json({ examined: 0, orphaned: 0, queued: 0 });

      // Chunked, and a throw aborts the whole request rather than being caught per
      // chunk: a partial read would look exactly like a pile of orphans and queue
      // deletes for live documents.
      const alive = new Set<number>();
      for (const ids of chunk(indexed, DB_CHUNK_SIZE)) {
        const rows = await dbRead.image.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        });
        for (const row of rows) alive.add(row.id);
      }

      const orphaned = indexed.filter((id) => !alive.has(id));
      const orphanRate = orphaned.length / indexed.length;
      // The measured rate is ~0.16% overall and ~20% on the worst single query, so
      // anything past half the page is far likelier to be a bad read than real orphans.
      if (orphanRate > maxOrphanRate) {
        return res.status(409).json({
          error: 'orphan rate above maxOrphanRate — refusing to queue deletes',
          examined: indexed.length,
          orphaned: orphaned.length,
          orphanRate,
        });
      }

      if (!dryRun && orphaned.length) {
        await queueImageSearchIndexUpdate({
          ids: orphaned,
          action: SearchIndexUpdateQueueAction.Delete,
        });
      }

      return res.status(200).json({
        dryRun,
        examined: indexed.length,
        orphaned: orphaned.length,
        orphanRate,
        queued: dryRun ? 0 : orphaned.length,
        sample: orphaned.slice(0, 25),
      });
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
