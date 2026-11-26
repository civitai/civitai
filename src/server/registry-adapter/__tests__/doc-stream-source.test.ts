import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { DocStreamBlock } from '~/server/registry-adapter/catalog-source';
import { readDocStreamApps } from '~/server/registry-adapter/catalog-source';
import { liveDocStreamReadDeps } from '~/server/registry-adapter/catalog-source.live';
import { docStreamResolvers } from '~/server/registry-adapter/doc-streams';
import type { CatalogApp, DocStreamApp } from '~/server/registry-adapter/entities';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';

/**
 * The private, per-viewer and level document streams resolve an app from every approved on-site
 * block not deleted (`readDocStreamApps`), whatever its store listing's visibility; the registry
 * export resolves only from the public catalog. `docStreamResolvers` is what `main.ts` wires, so
 * a resolver moved back onto the public catalog fails here. Fixture values are pairwise distinct.
 */

const NS = 'urn:schema:apps.civitai.com';
const collectionUrn = (slug: string, coll: string, n = 1) => `${NS}:${slug}/${coll}@v${n}`;
const viewerUrn = (slug: string, coll: string, n = 1) => `${NS}:${slug}/${coll}.viewer@v${n}`;

const schema = { type: 'object', properties: { title: { type: 'string', maxLength: 80 } } };
const manifestOf = (slug: string) => ({
  blockId: slug,
  storage: {
    collections: {
      boards: { visibility: 'shared', write: 'own', registry: 'public', schema },
      journal: { visibility: 'private', schema },
    },
  },
});

/** A block row as the live read selects it (`loadResolvableBlocks`). */
const blockRow = (slug: string, id: string, over: Partial<DocStreamBlock> = {}) => ({
  id,
  blockId: slug,
  version: '2.0.0',
  status: 'approved',
  contentRating: 'pg13',
  manifest: manifestOf(slug),
  ...over,
});

const release = (appBlockId: string, id: string, slug: string, reviewedAt: Date) => ({
  id,
  appBlockId,
  version: '1.0.0',
  manifest: manifestOf(slug),
  bundleSha256: null,
  commitSha: null,
  sourceCommit: null,
  reviewedAt,
});

/** The listed app, as the public catalog read (`readCatalog`) gives it. */
function catalogApp(slug: string, id: string): CatalogApp {
  return {
    listing: {
      slug,
      kind: 'onsite',
      name: 'Listed Board',
      tagline: null,
      category: null,
      contentRating: 'pg',
      iconUrl: null,
      creatorUsername: null,
      externalUrl: null,
      sourceRepoUrl: null,
      forkOf: null,
    },
    block: blockRow(slug, id),
    approved: [release(id, `pubreq_${id}`, slug, new Date('2026-01-02T00:00:00Z'))].map(
      ({ appBlockId: _a, ...r }) => r
    ),
  };
}

// The app whose store listing is visible to moderators only: never in the public catalog.
const HIDDEN = 'storage-demo';
const HIDDEN_ID = 'ab_hidden_71';
// A listed app, the export's positive control.
const LISTED = 'listed-board';
const LISTED_ID = 'ab_listed_53';

const SWITCH_ON = { ...APP_STORAGE_ENABLED_FEATURES, registryExport: true };

function hiddenDocApp(): DocStreamApp {
  return {
    listing: { contentRating: 'r' },
    block: blockRow(HIDDEN, HIDDEN_ID),
    approved: [release(HIDDEN_ID, 'pubreq_hidden_1', HIDDEN, new Date('2026-03-04T00:00:00Z'))].map(
      ({ appBlockId: _a, ...r }) => r
    ),
  };
}

function resolvers(catalog: CatalogApp[], docApps: DocStreamApp[]) {
  return docStreamResolvers({
    readCatalogApps: async () => catalog,
    readDocStreamApps: async () => docApps,
    docLevelsOn: async () => true,
    features: SWITCH_ON,
  });
}

describe('docStreamResolvers: which read each document stream resolves from', () => {
  const catalog = [catalogApp(LISTED, LISTED_ID)];
  const docApps = [hiddenDocApp(), { ...catalogApp(LISTED, LISTED_ID) }];

  it('🔴 an approved app missing from the public catalog resolves for the PRIVATE stream', async () => {
    const r = await resolvers(catalog, docApps).private(collectionUrn(HIDDEN, 'journal'));
    expect(r).toMatchObject({ appId: HIDDEN_ID, slug: HIDDEN, collection: 'journal' });
  });

  it('🔴 ...for the LEVEL stream, rated by its own listing', async () => {
    const r = await resolvers(catalog, docApps).level(collectionUrn(HIDDEN, 'boards'));
    expect(r).toMatchObject({
      appId: HIDDEN_ID,
      appBlockId: HIDDEN_ID,
      slug: HIDDEN,
      collection: 'boards',
      contentRating: 'r',
      levelsOn: true,
    });
  });

  it('🔴 ...and for the PER-VIEWER stream', async () => {
    const r = await resolvers(catalog, docApps).viewer(viewerUrn(HIDDEN, 'boards'));
    expect(r).toMatchObject({
      appId: HIDDEN_ID,
      slug: HIDDEN,
      collection: 'boards',
      collectionSchema: collectionUrn(HIDDEN, 'boards'),
    });
  });

  it('🔴 the same app is NOT exported: the export reads the public catalog only', async () => {
    expect(await resolvers(catalog, docApps).exported(collectionUrn(HIDDEN, 'boards'))).toBeNull();
  });

  it('positive control: a listed app IS exported, with the switch and levels on', async () => {
    expect(
      await resolvers(catalog, docApps).exported(collectionUrn(LISTED, 'boards'))
    ).toMatchObject({ appId: LISTED_ID, slug: LISTED, collection: 'boards', docLevels: true });
  });

  it('the export ignores the document-stream read: an app only there exports nothing', async () => {
    // The listed app is dropped from the catalog but kept in the document-stream read.
    expect(await resolvers([], docApps).exported(collectionUrn(LISTED, 'boards'))).toBeNull();
  });

  it('an app absent from the document-stream read resolves for none of the three', async () => {
    const r = resolvers([catalogApp(HIDDEN, HIDDEN_ID)], []);
    expect(await r.private(collectionUrn(HIDDEN, 'journal'))).toBeNull();
    expect(await r.level(collectionUrn(HIDDEN, 'boards'))).toBeNull();
    expect(await r.viewer(viewerUrn(HIDDEN, 'boards'))).toBeNull();
  });
});

describe('readDocStreamApps', () => {
  it('carries each block, its listing rating (null: none) and its releases in review order', async () => {
    const apps = await readDocStreamApps({
      loadResolvableBlocks: async () => [
        { ...blockRow(HIDDEN, HIDDEN_ID), listingContentRating: 'x' },
        { ...blockRow(LISTED, LISTED_ID, { contentRating: 'pg' }), listingContentRating: null },
      ],
      loadApproved: async (ids) => {
        expect(ids).toEqual([HIDDEN_ID, LISTED_ID]);
        return [
          release(HIDDEN_ID, 'pubreq_b', HIDDEN, new Date('2026-05-01T00:00:00Z')),
          release(LISTED_ID, 'pubreq_c', LISTED, new Date('2026-04-01T00:00:00Z')),
          release(HIDDEN_ID, 'pubreq_a', HIDDEN, new Date('2026-02-01T00:00:00Z')),
        ];
      },
    });
    expect(
      apps.map((a) => [a.block?.id, a.listing.contentRating, a.approved.map((r) => r.id)])
    ).toEqual([
      [HIDDEN_ID, 'x', ['pubreq_a', 'pubreq_b']],
      [LISTED_ID, null, ['pubreq_c']],
    ]);
    expect(apps[0].approved[0]).not.toHaveProperty('appBlockId');
  });

  it('reads no releases when no block resolves', async () => {
    const apps = await readDocStreamApps({
      loadResolvableBlocks: async () => [],
      loadApproved: async () => {
        throw new Error('must not be read');
      },
    });
    expect(apps).toEqual([]);
  });
});

/**
 * The live read (`liveDocStreamReadDeps`): the block query is answered by a stand-in that honours
 * its `where`, so the filter itself decides which fixture rows come back.
 */
describe('liveDocStreamReadDeps → readDocStreamApps → the resolvers', () => {
  type Row = ReturnType<typeof blockRow> & {
    externalUrl: string | null;
    appListing: { contentRating: string | null } | null;
  };
  let rows: Row[];
  let deletedIds: string[];
  let rawError: unknown;

  const row = (slug: string, id: string, over: Partial<Row> = {}): Row => ({
    ...blockRow(slug, id),
    externalUrl: null,
    appListing: { contentRating: 'pg13' },
    ...over,
  });

  beforeEach(() => {
    rawError = undefined;
    deletedIds = [];
    rows = [];
    dbMock.dbRead.appBlock.findMany.mockImplementation(
      async ({
        where,
        select,
      }: {
        where: { status?: string; externalUrl?: null };
        select: Record<string, unknown>;
      }) =>
        rows
          .filter((r) => where.status === undefined || r.status === where.status)
          .filter((r) => !('externalUrl' in where) || r.externalUrl === where.externalUrl)
          .map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k as keyof Row]])))
    );
    dbMock.dbRead.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      expect(strings.join('?')).toContain('storage_deleted_at IS NOT NULL');
      if (rawError) throw rawError;
      return deletedIds.map((id) => ({ id }));
    });
    dbMock.dbRead.appBlockPublishRequest.findMany.mockImplementation(
      async ({ where }: { where: { appBlockId: { in: string[] } } }) =>
        where.appBlockId.in.map((id) => ({
          ...release(id, `pubreq_${id}`, rows.find((r) => r.id === id)!.blockId, new Date(0)),
          appBlockId: id,
          forgejoCommitSha: null,
        }))
    );
  });

  const resolveAll = async () => {
    const apps = await readDocStreamApps(liveDocStreamReadDeps());
    const r = docStreamResolvers({
      readCatalogApps: async () => [],
      readDocStreamApps: async () => apps,
      docLevelsOn: async () => true,
    });
    return {
      ids: apps.map((a) => a.block?.id),
      private: (slug: string) => r.private(collectionUrn(slug, 'journal')),
      level: (slug: string) => r.level(collectionUrn(slug, 'boards')),
      viewer: (slug: string) => r.viewer(viewerUrn(slug, 'boards')),
    };
  };

  it('🔴 an approved block with a moderators-only listing, or none, resolves on all three paths', async () => {
    rows = [
      row(HIDDEN, HIDDEN_ID, { appListing: { contentRating: 'r' } }),
      row('unlisted-app', 'ab_unlisted_9', { appListing: null, contentRating: 'pg' }),
    ];
    const r = await resolveAll();
    for (const [slug, id, rating] of [
      [HIDDEN, HIDDEN_ID, 'r'],
      ['unlisted-app', 'ab_unlisted_9', 'pg'],
    ]) {
      expect(await r.private(slug)).toMatchObject({ appId: id });
      expect(await r.level(slug)).toMatchObject({ appId: id, contentRating: rating });
      expect(await r.viewer(slug)).toMatchObject({ appId: id });
    }
  });

  it('🔴 an unapproved, suspended, external or storage-deleted block resolves on none', async () => {
    rows = [
      row('pending-app', 'ab_pending_1', { status: 'pending' }),
      row('suspended-app', 'ab_suspended_2', { status: 'suspended' }),
      row('external-app', 'ab_external_3', { externalUrl: 'https://example.test/app' }),
      row('deleted-app', 'ab_deleted_4'),
      // Positive control: the one row that must come back.
      row('kept-app', 'ab_kept_5'),
    ];
    deletedIds = ['ab_deleted_4'];
    const r = await resolveAll();
    expect(r.ids).toEqual(['ab_kept_5']);
    expect(await r.private('kept-app')).toMatchObject({ appId: 'ab_kept_5' });
    for (const slug of ['pending-app', 'suspended-app', 'external-app', 'deleted-app']) {
      expect(await r.private(slug)).toBeNull();
      expect(await r.level(slug)).toBeNull();
      expect(await r.viewer(slug)).toBeNull();
    }
  });

  it('the deletion column not yet applied (42703): no block is read as deleted', async () => {
    rows = [row('kept-app', 'ab_kept_5')];
    rawError = Object.assign(new Error('column "storage_deleted_at" does not exist'), {
      code: '42703',
    });
    expect((await resolveAll()).ids).toEqual(['ab_kept_5']);
  });

  it('🔴 any other failure reading the deletions fails the read: a deleted app never resolves by default', async () => {
    rows = [row('deleted-app', 'ab_deleted_4')];
    rawError = Object.assign(new Error('connection reset'), { code: '08006' });
    await expect(readDocStreamApps(liveDocStreamReadDeps())).rejects.toThrow('connection reset');
  });
});
