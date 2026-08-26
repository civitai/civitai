import { constants } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { applyArticleContentChange } from '~/server/services/article.service';
import { applyBountyContentChange } from '~/server/services/bounty.service';
import { applyCosmeticShopItemContentChange } from '~/server/services/cosmetic-shop.service';
import { applyModelContentChange } from '~/server/services/model.service';
import { applyModelVersionContentChange } from '~/server/services/model-version.service';

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
//
// Every `save` here goes through an `apply<Entity>ContentChange`, never the entity's
// form-shaped upsert: a partial payload to one of those does not update a column, it
// clears every field it omits.
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
  Model: {
    load: async (entityId) => {
      const row = await dbRead.model.findUnique({
        where: { id: entityId },
        select: { userId: true, description: true },
      });
      return row ? { userId: row.userId, html: row.description ?? '' } : null;
    },
    // NOT `updateModelById`: that runs neither the text-moderation submit nor the
    // response-cache bust, so a rewritten description would go unscanned and keep
    // serving its old text from the public model API.
    save: ({ entityId, html }) => applyModelContentChange({ id: entityId, description: html }),
  },
  ModelVersion: {
    load: async (entityId) => {
      const row = await dbRead.modelVersion.findUnique({
        where: { id: entityId },
        select: { description: true, model: { select: { userId: true } } },
      });
      return row ? { userId: row.model.userId, html: row.description ?? '' } : null;
    },
    save: ({ entityId, html }) =>
      applyModelVersionContentChange({ id: entityId, description: html }),
  },
  Bounty: {
    load: async (entityId) => {
      const row = await dbRead.bounty.findUnique({
        where: { id: entityId },
        select: { userId: true, description: true },
      });
      // `Bounty.userId` is nullable (the owner's account can be deleted out from under it),
      // and nothing downstream reads this one — the save writes a column and no more.
      return row ? { userId: row.userId ?? constants.system.user.id, html: row.description } : null;
    },
    save: ({ entityId, html }) => applyBountyContentChange({ id: entityId, description: html }),
  },
  CosmeticShopItem: {
    load: async (entityId) => {
      const row = await dbRead.cosmeticShopItem.findUnique({
        where: { id: entityId },
        select: { addedById: true, description: true },
      });
      return row
        ? { userId: row.addedById ?? constants.system.user.id, html: row.description ?? '' }
        : null;
    },
    save: ({ entityId, html }) =>
      applyCosmeticShopItemContentChange({ id: entityId, description: html }),
  },
};

export function getBlurbFanoutAdapter(entityType: string): BlurbFanoutAdapter | undefined {
  return adapters[entityType];
}

export function getSupportedBlurbEntityTypes(): string[] {
  return Object.keys(adapters);
}
