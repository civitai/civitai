import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ArticleService from '~/server/services/article.service';
import type * as BountyService from '~/server/services/bounty.service';
import type * as CosmeticShopService from '~/server/services/cosmetic-shop.service';
import type * as ModelService from '~/server/services/model.service';
import type * as ModelVersionService from '~/server/services/model-version.service';

// The real registry, unmocked — this is what would miss a `save` swapped from an
// `apply<Entity>ContentChange` to the entity's form-shaped upsert. Only the exports the
// adapters call are overridden; everything else is the real module.
//
// Hoisted: the adapters module imports every service mocked below, so these factories run
// while this file's own imports are still resolving.
const applies = vi.hoisted(() => ({
  applyArticleContentChange: vi.fn(),
  applyBountyContentChange: vi.fn(),
  applyCosmeticShopItemContentChange: vi.fn(),
  applyModelContentChange: vi.fn(),
  applyModelVersionContentChange: vi.fn(),
}));

// The functions a `save` must NEVER reach. Each takes a whole form payload, so a partial call
// clears every field it omits rather than updating one column.
const upserts = vi.hoisted(() => ({
  upsertArticle: vi.fn(),
  upsertBounty: vi.fn(),
  upsertCosmeticShopItem: vi.fn(),
  upsertModel: vi.fn(),
  updateModelById: vi.fn(),
  upsertModelVersion: vi.fn(),
}));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  applyArticleContentChange: applies.applyArticleContentChange,
  upsertArticle: upserts.upsertArticle,
}));
vi.mock('~/server/services/bounty.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyService>()),
  applyBountyContentChange: applies.applyBountyContentChange,
  upsertBounty: upserts.upsertBounty,
}));
vi.mock('~/server/services/cosmetic-shop.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopService>()),
  applyCosmeticShopItemContentChange: applies.applyCosmeticShopItemContentChange,
  upsertCosmeticShopItem: upserts.upsertCosmeticShopItem,
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  applyModelContentChange: applies.applyModelContentChange,
  upsertModel: upserts.upsertModel,
  updateModelById: upserts.updateModelById,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  applyModelVersionContentChange: applies.applyModelVersionContentChange,
  upsertModelVersion: upserts.upsertModelVersion,
}));

const { getBlurbFanoutAdapter, getSupportedBlurbEntityTypes } = await import(
  '~/server/services/blurb-fanout.adapters'
);

// The v1 surfaces, spelled the way `reconcileBlurbReferences` is called with them. A key that
// drifts from its call site is silent: references accumulate and the job reports them
// `unsupported` forever.
const V1_ENTITY_TYPES = ['Article', 'Model', 'ModelVersion', 'Bounty', 'CosmeticShopItem'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getBlurbFanoutAdapter', () => {
  it.each(V1_ENTITY_TYPES)('resolves an adapter for %s', (entityType) => {
    expect(getBlurbFanoutAdapter(entityType)).toBeDefined();
  });

  it('registers exactly the v1 entity types and nothing else', () => {
    expect(getSupportedBlurbEntityTypes().sort()).toEqual([...V1_ENTITY_TYPES].sort());
  });

  it.each(['Comment', 'Changelog', 'Challenge'])(
    'resolves undefined for %s, which is out of v1 deliberately',
    (entityType) => {
      // Changelog and Challenge were dropped from v1 (no defensible owner to resolve spans
      // against; a background rewrite would hide a live challenge). Nothing passes either
      // string to reconcileBlurbReferences, so no reference row can name them — but if one
      // ever did, the fan-out must report it `unsupported` rather than rewrite it.
      expect(getBlurbFanoutAdapter(entityType)).toBeUndefined();
    }
  );
});

describe('adapter save', () => {
  // Every adapter must forward `expectedHtml` as its entity's expected-column argument. Drop it
  // from one and that surface silently loses the compare-and-set: the fan-out goes back to
  // replaying a stale body over a save that committed between its load and its write.
  const cases: Array<[string, keyof typeof applies, Record<string, unknown>]> = [
    [
      'Article',
      'applyArticleContentChange',
      { id: 5, userId: 9, content: '<p>hi</p>', expectedContent: 'OLD' },
    ],
    [
      'Model',
      'applyModelContentChange',
      { id: 5, description: '<p>hi</p>', expectedDescription: 'OLD' },
    ],
    [
      'ModelVersion',
      'applyModelVersionContentChange',
      { id: 5, description: '<p>hi</p>', expectedDescription: 'OLD' },
    ],
    [
      'Bounty',
      'applyBountyContentChange',
      { id: 5, description: '<p>hi</p>', expectedDescription: 'OLD' },
    ],
    [
      'CosmeticShopItem',
      'applyCosmeticShopItemContentChange',
      { id: 5, description: '<p>hi</p>', expectedDescription: 'OLD' },
    ],
  ];

  it.each(cases)('%s routes through %s', async (entityType, applyName, expected) => {
    const adapter = getBlurbFanoutAdapter(entityType)!;
    await adapter.save({ entityId: 5, userId: 9, html: '<p>hi</p>', expectedHtml: 'OLD' });

    expect(applies[applyName]).toHaveBeenCalledWith(expected);
  });

  it('reaches no form-shaped upsert on any surface', async () => {
    for (const entityType of V1_ENTITY_TYPES) {
      await getBlurbFanoutAdapter(entityType)!.save({
        entityId: 5,
        userId: 9,
        html: '<p>hi</p>',
        expectedHtml: 'OLD',
      });
    }

    for (const [name, fn] of Object.entries(upserts)) {
      expect(fn, `${name} was called by an adapter save`).not.toHaveBeenCalled();
    }
  });
});

describe('adapter load', () => {
  it('returns the owner and html for Model', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({ userId: 9, description: '<p>hi</p>' });
    await expect(getBlurbFanoutAdapter('Model')!.load(5)).resolves.toEqual({
      userId: 9,
      html: '<p>hi</p>',
    });
  });

  it('reads the owner off the parent model for ModelVersion', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
      description: '<p>hi</p>',
      model: { userId: 9 },
    });
    await expect(getBlurbFanoutAdapter('ModelVersion')!.load(5)).resolves.toEqual({
      userId: 9,
      html: '<p>hi</p>',
    });
  });

  it('falls back to the system actor for a bounty whose owner was deleted', async () => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({ userId: null, description: '<p>hi</p>' });
    await expect(getBlurbFanoutAdapter('Bounty')!.load(5)).resolves.toEqual({
      userId: -1,
      html: '<p>hi</p>',
    });
  });

  it('reads addedById for a cosmetic shop item', async () => {
    dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({
      addedById: 9,
      description: '<p>hi</p>',
    });
    await expect(getBlurbFanoutAdapter('CosmeticShopItem')!.load(5)).resolves.toEqual({
      userId: 9,
      html: '<p>hi</p>',
    });
  });

  it('returns the owner and html from the article row', async () => {
    dbMock.dbRead.article.findUnique.mockResolvedValue({ userId: 9, content: '<p>hi</p>' });
    await expect(getBlurbFanoutAdapter('Article')!.load(5)).resolves.toEqual({
      userId: 9,
      html: '<p>hi</p>',
    });
  });

  it.each(V1_ENTITY_TYPES)('returns null when the %s no longer exists', async (entityType) => {
    for (const model of ['article', 'model', 'modelVersion', 'bounty', 'cosmeticShopItem'] as const)
      dbMock.dbRead[model].findUnique.mockResolvedValue(null);

    await expect(getBlurbFanoutAdapter(entityType)!.load(5)).resolves.toBeNull();
  });

  it('selects only userId and content for an article', async () => {
    dbMock.dbRead.article.findUnique.mockResolvedValue({ userId: 9, content: '<p>hi</p>' });
    await getBlurbFanoutAdapter('Article')!.load(5);

    const [args] = dbMock.dbRead.article.findUnique.mock.calls[0];
    expect(args.select).toEqual({ userId: true, content: true });
  });
});
