import { dbRead } from '~/server/db/client';
import { applyArticleContentChange } from '~/server/services/article.service';

export type BlurbFanoutAdapter = {
  /** `null` means the entity no longer exists and the reference should be dropped. */
  load: (entityId: number) => Promise<{ userId: number; html: string } | null>;
  /**
   * Persist through the entity's NORMAL update function. Writing the column
   * directly would skip the moderation scan, the search-index sync, the cache
   * invalidation and Prisma's `@updatedAt` — which is the entire reason the text
   * is materialised in the first place.
   */
  save: (args: { entityId: number; userId: number; html: string }) => Promise<void>;
};

// Keys MUST match the `entityType` strings passed to `reconcileBlurbReferences`
// (see blurb-materialize.service.ts). A mismatch is silent: references
// accumulate, the fan-out reports them `unsupported` forever, and nothing
// rewrites them.
const adapters: Record<string, BlurbFanoutAdapter> = {
  Article: {
    load: async (entityId) => {
      const row = await dbRead.article.findUnique({
        where: { id: entityId },
        select: { userId: true, content: true },
      });
      return row ? { userId: row.userId, html: row.content } : null;
    },
    // `applyArticleContentChange`, NOT `upsertArticle`. The upsert takes a whole form
    // payload — title, tags, attachments, cover — and a partial call to it does not
    // update a column, it clears every field it omits.
    save: ({ entityId, userId, html }) =>
      applyArticleContentChange({ id: entityId, userId, content: html }),
  },
};

export function getBlurbFanoutAdapter(entityType: string): BlurbFanoutAdapter | undefined {
  return adapters[entityType];
}

export function getSupportedBlurbEntityTypes(): string[] {
  return Object.keys(adapters);
}
