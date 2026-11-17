import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The consent side of the source-rating rule: on a host that cannot show mature content, a
 * mature-rated source resolves as unavailable, so the consent modal does not offer it and
 * `blocks.grantScopes` writes no grant for it. The storage route applies the same rule to the
 * consumer token's ceiling (`doc-store-api.contract.test.ts`).
 *
 * `server-domain.ts` builds its host map from the environment at import, so the hosts are stubbed
 * before the service is imported (same shape as `server-domain.nsfw-rating.test.ts`).
 */
vi.stubEnv('SERVER_DOMAIN_GREEN', 'civitai.green');
vi.stubEnv('SERVER_DOMAIN_GREEN_ALIASES', '');
vi.stubEnv('SERVER_DOMAIN_BLUE', 'civitai.com');
vi.stubEnv('SERVER_DOMAIN_BLUE_ALIASES', 'civitai.red');
vi.stubEnv('SERVER_DOMAIN_RED', 'civitai.red');
vi.stubEnv('SERVER_DOMAIN_RED_ALIASES', '');

const { resolveDeclaredImports } = await import(
  '~/server/services/apps/storage-import-grant.service'
);

const MANIFEST = {
  scopes: ['apps:storage', 'apps:storage:import'],
  storage: {
    imports: [
      { from: 'mature-app', collections: ['notes'], access: 'read' },
      { from: 'sfw-app', collections: ['notes'], access: 'read' },
    ],
  },
};

dbMock.dbRead.appBlock.findMany.mockResolvedValue([
  {
    id: 'apb_mature_3601',
    blockId: 'mature-app',
    manifest: { name: 'Mature', contentRating: 'x' },
  },
  { id: 'apb_sfw_3602', blockId: 'sfw-app', manifest: { name: 'Safe', contentRating: 'g' } },
]);

const sources = async (host: string) =>
  Object.fromEntries(
    (await resolveDeclaredImports(MANIFEST, { host })).map((i) => [
      i.from,
      i.source?.appBlockId ?? null,
    ])
  );

describe('a mature-rated source on the consent surfaces', () => {
  it('is unavailable on a host that cannot show mature content; a SFW source is not', async () => {
    expect(await sources('civitai.com')).toEqual({ 'mature-app': null, 'sfw-app': 'apb_sfw_3602' });
    expect(await sources('civitai.green')).toEqual({
      'mature-app': null,
      'sfw-app': 'apb_sfw_3602',
    });
  });

  it('is available on a red-capable host', async () => {
    expect(await sources('civitai.red')).toEqual({
      'mature-app': 'apb_mature_3601',
      'sfw-app': 'apb_sfw_3602',
    });
  });

  it('says why it is unavailable', async () => {
    const [mature] = await resolveDeclaredImports(MANIFEST, { host: 'civitai.com' });
    expect(mature).toMatchObject({
      from: 'mature-app',
      source: null,
      unavailable: 'source_rating',
    });
  });
});
