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
   * Persist through the entity's `apply<Entity>ContentChange`, never a direct column write.
   * `expectedHtml` is the body `load` returned; `false` means someone else wrote in between and
   * nothing was written here.
   */
  save: (args: {
    entityId: number;
    userId: number;
    html: string;
    expectedHtml: string;
  }) => Promise<boolean>;
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
    save: ({ entityId, userId, html, expectedHtml }) =>
      applyArticleContentChange({
        id: entityId,
        userId,
        content: html,
        expectedContent: expectedHtml,
      }),
  },
  Model: {
    load: async (entityId) => {
      const row = await dbRead.model.findUnique({
        where: { id: entityId },
        select: { userId: true, description: true },
      });
      return row ? { userId: row.userId, html: row.description ?? '' } : null;
    },
    save: ({ entityId, html, expectedHtml }) =>
      applyModelContentChange({
        id: entityId,
        description: html,
        expectedDescription: expectedHtml,
      }),
  },
  ModelVersion: {
    load: async (entityId) => {
      const row = await dbRead.modelVersion.findUnique({
        where: { id: entityId },
        select: { description: true, model: { select: { userId: true } } },
      });
      return row ? { userId: row.model.userId, html: row.description ?? '' } : null;
    },
    save: ({ entityId, html, expectedHtml }) =>
      applyModelVersionContentChange({
        id: entityId,
        description: html,
        expectedDescription: expectedHtml,
      }),
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
    save: ({ entityId, html, expectedHtml }) =>
      applyBountyContentChange({
        id: entityId,
        description: html,
        expectedDescription: expectedHtml,
      }),
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
    save: ({ entityId, html, expectedHtml }) =>
      applyCosmeticShopItemContentChange({
        id: entityId,
        description: html,
        expectedDescription: expectedHtml,
      }),
  },
};

export function getBlurbFanoutAdapter(entityType: string): BlurbFanoutAdapter | undefined {
  return adapters[entityType];
}

export function getSupportedBlurbEntityTypes(): string[] {
  return Object.keys(adapters);
}
