import { describe, expect, it } from 'vitest';
import type {
  CatalogApprovedRequest,
  CatalogReadDeps,
} from '~/server/registry-adapter/catalog-source';
import { readCatalog } from '~/server/registry-adapter/catalog-source';
import { resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import { createSchemaMajorResolver } from '~/server/services/apps/doc-store-schema-major';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';

/**
 * 🔴 THE SEAM between the two consumers of collection majors. The document store stamps each
 * write with its collection's current major (`doc-store-schema-major.ts`); the registry adapter
 * publishes one schema per major (`readCatalog` → `resolveFromCatalog`). Each side reads the
 * app's approved publish requests and enforced manifest on its own and orders them on its own,
 * so this drives BOTH real paths over the same rows and asserts the store's major is the
 * adapter's newest major — and that both are the literal major the history should produce.
 *
 * The rows are handed over in an order neither side may depend on (newest first, ties out of id
 * order), so a side that dropped or changed its ordering disagrees here.
 */

const SLUG = 'pixel-garden';
const APP = 'ab_AGREE_5101';
const V = (n: number) => `urn:schema:apps.civitai.com:${SLUG}/cards@v${n}`;

type S = Record<string, unknown>;
const cards = (schema: S, extra: S = {}) => ({
  visibility: 'shared',
  write: 'own',
  registry: 'public',
  schema,
  ...extra,
});
const manifest = (cardsDecl: S) => ({
  blockId: SLUG,
  storage: { collections: { cards: cardsDecl } },
});
const obj = (properties: S, extra: S = {}): S => ({ type: 'object', properties, ...extra });

const S1 = obj({ title: { type: 'string', maxLength: 80 } });
const S1_PLUS = obj({ title: { type: 'string', maxLength: 80 }, mood: { type: 'string' } });
const S1_WIDER = obj({ title: { type: 'string', maxLength: 200 } });
const CLOSED_V1 = obj({ name: { type: 'string' }, keep: {} }, { additionalProperties: false });
const CLOSED_V2 = obj({ title: { type: 'string' }, keep: {} }, { additionalProperties: false });
const RENAME = [{ op: 'rename', from: '/name', to: '/title' }];

const req = (id: string, cardsDecl: S, reviewedAt: string): CatalogApprovedRequest => ({
  id,
  appBlockId: APP,
  version: '1.0.0',
  manifest: manifest(cardsDecl),
  bundleSha256: null,
  commitSha: null,
  sourceCommit: null,
  reviewedAt: new Date(reviewedAt),
});

/** The adapter's newest major for `cards`: the length of the schema family it publishes. */
async function adapterMajor(approved: CatalogApprovedRequest[], head: unknown): Promise<number> {
  const deps: CatalogReadDeps = {
    resolveScope: async () => 'full',
    listPage: async () => ({
      items: [
        {
          id: 'apl_agree',
          slug: SLUG,
          kind: 'onsite',
          name: 'Pixel Garden',
          tagline: null,
          category: null,
          contentRating: 'pg',
          creatorUsername: null,
          appBlockId: APP,
          externalUrl: null,
        },
      ],
    }),
    loadBlocks: async () => [
      {
        id: APP,
        blockId: SLUG,
        version: '1.0.0',
        status: 'approved',
        contentRating: 'pg',
        manifest: head,
      },
    ],
    loadApproved: async () => approved,
    loadSourceRepoUrls: async () => new Map(),
    loadForkParents: async () => new Map(),
    loadIconUrls: async () => new Map(),
  };
  const apps = await readCatalog(deps);
  const resolve = resolveFromCatalog(async () => apps, {
    ...APP_STORAGE_ENABLED_FEATURES,
    registryExport: true,
  });
  // The family of any published major is the whole family; @v1 always exists.
  const stream = await resolve(V(1));
  if (!stream) throw new Error('the adapter published no cards stream');
  return stream.family.length;
}

/** The store's major for `cards`: what a production write is stamped with. */
async function storeMajor(
  approved: CatalogApprovedRequest[],
  head: unknown
): Promise<number | null> {
  const resolve = createSchemaMajorResolver({
    readApproved: async (appBlockId) => {
      expect(appBlockId).toBe(APP);
      return approved.map(({ id, manifest, reviewedAt }) => ({ id, manifest, reviewedAt }));
    },
    onError: (err) => {
      throw err;
    },
  });
  return resolve({
    appBlockId: APP,
    head: { manifest: head, revision: null },
    collection: 'cards',
  });
}

describe('store and registry adapter derive the same current major', () => {
  it.each<[string, CatalogApprovedRequest[], unknown, number]>([
    ['one approval', [req('pubreq_a', cards(S1), '2026-10-01T00:00:00Z')], manifest(cards(S1)), 1],
    [
      'a new optional property keeps the major',
      [
        req('pubreq_b', cards(S1_PLUS), '2026-10-02T00:00:00Z'),
        req('pubreq_a', cards(S1), '2026-10-01T00:00:00Z'),
      ],
      manifest(cards(S1_PLUS)),
      1,
    ],
    [
      'a widening mints',
      [
        req('pubreq_b', cards(S1_WIDER), '2026-10-02T00:00:00Z'),
        req('pubreq_a', cards(S1), '2026-10-01T00:00:00Z'),
      ],
      manifest(cards(S1_WIDER)),
      2,
    ],
    [
      'a closing rename mints',
      [
        req('pubreq_b', cards(CLOSED_V2, { migrations: RENAME }), '2026-10-02T00:00:00Z'),
        req('pubreq_a', cards(CLOSED_V1), '2026-10-01T00:00:00Z'),
      ],
      manifest(cards(CLOSED_V2, { migrations: RENAME })),
      2,
    ],
    [
      'a rollback to an older schema is a third major, not the first',
      [
        req('pubreq_c', cards(S1), '2026-10-03T00:00:00Z'),
        req('pubreq_b', cards(S1_WIDER), '2026-10-02T00:00:00Z'),
        req('pubreq_a', cards(S1), '2026-10-01T00:00:00Z'),
      ],
      manifest(cards(S1)),
      3,
    ],
    [
      'an enforced manifest that diverges from the latest approval mints on its own',
      [req('pubreq_a', cards(S1), '2026-10-01T00:00:00Z')],
      manifest(cards(S1_WIDER)),
      2,
    ],
    [
      // Same reviewedAt: the id decides. In id order (a, b) the narrowing to S1 then the additive
      // S1_PLUS give @v2; the reverse would give @v3. Handed over as (b, a).
      'a tie on reviewedAt is ordered by id',
      [
        req('pubreq_tie_b', cards(S1_PLUS), '2026-10-02T00:00:00Z'),
        req('pubreq_tie_a', cards(S1), '2026-10-02T00:00:00Z'),
        req('pubreq_first', cards(S1_WIDER), '2026-10-01T00:00:00Z'),
      ],
      manifest(cards(S1_PLUS)),
      2,
    ],
  ])('%s', async (_name, approved, head, expected) => {
    const adapter = await adapterMajor(approved, head);
    const store = await storeMajor(approved, head);
    expect({ adapter, store }).toEqual({ adapter: expected, store: expected });
  });
});
