import { MeiliSearch } from 'meilisearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { IMAGES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import type { SiteSearchViewer } from '~/server/services/site-search.service';
import {
  SITE_SEARCH_INDEXES,
  siteFacetSearch,
  siteIndexSearch,
  siteMultiSearch,
} from '~/server/services/site-search.service';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';
import { modelsSearchableAttributes } from '~/server/search-index/searchable-attributes';

/**
 * Site search against a REAL Meilisearch: the viewer clauses only mean anything if Meilisearch
 * applies them the way the service assumes, which no mock can show. Opt-in, because it needs a
 * running instance:
 *
 *   docker run -d -p 7719:7700 -e MEILI_MASTER_KEY=<key> getmeili/meilisearch:v1.11
 *   MEILI_IT_HOST=http://127.0.0.1:7719 MEILI_IT_MASTER_KEY=<key> \
 *     pnpm exec vitest run --project 'unit*' src/server/services/__tests__/site-search.meili.integration.test.ts
 *
 * It creates and deletes its own indexes and keys, so point it at a throwaway instance only.
 */
const HOST = process.env.MEILI_IT_HOST;
const MASTER_KEY = process.env.MEILI_IT_MASTER_KEY;

const CONTROL = 1;
const RESTRICTED = 2; // poi, owned by OWNER
const PRIVATE = 3;
const MATURE = 4;
const FACED = 5; // mature listing with a civitai.com face
const OWNER = 7;
const OTHER_USER = 99;
// An index the site never searches.
const UNLISTED_INDEX = 'models';

const { PG, R } = NsfwLevel;
const modelDocs = [
  {
    id: CONTROL,
    name: 'Control',
    poi: false,
    availability: 'Public',
    nsfwLevel: [PG],
    user: { id: 5 },
  },
  {
    id: RESTRICTED,
    name: 'Restricted',
    poi: true,
    availability: 'Public',
    nsfwLevel: [PG],
    user: { id: OWNER },
  },
  {
    id: PRIVATE,
    name: 'Private',
    poi: false,
    availability: 'Private',
    nsfwLevel: [PG],
    user: { id: 9 },
  },
  {
    id: MATURE,
    name: 'Mature',
    poi: false,
    availability: 'Public',
    nsfwLevel: [R],
    user: { id: 5 },
  },
  {
    id: FACED,
    name: 'Red Title',
    sfwName: 'Com Title',
    poi: false,
    availability: 'Public',
    nsfwLevel: [PG, R],
    user: { id: 5 },
  },
];

const anonymousOnRed: SiteSearchViewer = {
  browsingLevelCap: publicBrowsingLevelsFlag,
  showSfwFace: true,
};
const signedInOnRed: SiteSearchViewer = { userId: OTHER_USER, showSfwFace: false };
const signedInOnCom: SiteSearchViewer = {
  userId: OTHER_USER,
  browsingLevelCap: sfwBrowsingLevelsFlag,
  showSfwFace: true,
};

const hitsOf = (body: unknown) => (body as { hits: Record<string, unknown>[] }).hits;
const idsOf = (body: unknown) =>
  hitsOf(body)
    .map((hit) => hit.id as number)
    .sort();

async function search(viewer: SiteSearchViewer, filter?: string | (string | string[])[]) {
  const { status, body } = await siteIndexSearch(MODELS_SEARCH_INDEX, { q: '', filter }, viewer);
  expect(status, JSON.stringify(body)).toBe(200);
  return idsOf(body);
}

describe.skipIf(!HOST || !MASTER_KEY)('site search on a real Meilisearch', () => {
  let admin: MeiliSearch;
  let searchKeyUid: string;

  beforeAll(async () => {
    admin = new MeiliSearch({ host: HOST!, apiKey: MASTER_KEY });
    for (const index of [...SITE_SEARCH_INDEXES, IMAGES_SEARCH_INDEX, UNLISTED_INDEX])
      await admin.waitForTask((await admin.deleteIndex(index)).taskUid);

    const models = admin.index(MODELS_SEARCH_INDEX);
    await admin.waitForTask(
      (
        await models.updateFilterableAttributes([
          'id',
          'poi',
          'availability',
          'user.id',
          'nsfwLevel',
        ])
      ).taskUid
    );
    // The production list, so dropping either title from it fails the cross-title search below.
    await admin.waitForTask(
      (
        await models.updateSearchableAttributes(modelsSearchableAttributes)
      ).taskUid
    );
    await admin.waitForTask((await models.addDocuments(modelDocs)).taskUid);
    await admin.waitForTask((await admin.index(UNLISTED_INDEX).addDocuments(modelDocs)).taskUid);

    const searchKey = await admin.createKey({
      description: 'integration: site search key',
      actions: ['search'],
      indexes: ['*'],
      expiresAt: null,
    });
    searchKeyUid = searchKey.uid;
    setEnv({ NEXT_PUBLIC_SEARCH_HOST: HOST, SEARCH_TOKEN_API_KEY: searchKey.key });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.deleteKey(searchKeyUid).catch(() => null);
    for (const index of [...SITE_SEARCH_INDEXES, IMAGES_SEARCH_INDEX, UNLISTED_INDEX])
      await admin.deleteIndex(index).catch(() => null);
  });

  it('fixture control: a moderator on .red sees every model', async () => {
    expect(await search({ isModerator: true, showSfwFace: false })).toEqual([
      CONTROL,
      RESTRICTED,
      PRIVATE,
      MATURE,
      FACED,
    ]);
  });

  describe.each([
    ['an anonymous viewer', anonymousOnRed],
    ['a signed-in non-moderator', signedInOnRed],
  ])('%s', (_label, viewer) => {
    it.each([
      ['poi = true'],
      [`id = ${RESTRICTED}`],
      [`id = ${PRIVATE}`],
      ['availability = Private'],
    ])('filter "%s" cannot reach a restricted model', async (filter) => {
      expect(await search(viewer, filter)).not.toContain(RESTRICTED);
      expect(await search(viewer, filter)).not.toContain(PRIVATE);
    });

    it('cannot OR its way out of the viewer clauses from inside its own filter', async () => {
      const { status } = await siteIndexSearch(
        MODELS_SEARCH_INDEX,
        { q: '', filter: `id >= 0) OR (id >= 0` },
        viewer
      );
      expect(status).toBe(400);
      expect(await search(viewer, ['id >= 0', ['poi = true', 'id >= 0']])).not.toContain(
        RESTRICTED
      );
    });

    it('multi-search (what the browser sends) is held to the same clauses', async () => {
      const { status, body } = await siteMultiSearch(
        { queries: [{ indexUid: MODELS_SEARCH_INDEX, q: '', filter: 'poi = true' }] },
        viewer
      );
      expect(status).toBe(200);
      expect((body as { results: { hits: unknown[] }[] }).results[0].hits).toEqual([]);
    });

    it('facet counts are held to the same clauses', async () => {
      const { status, body } = await siteFacetSearch(
        MODELS_SEARCH_INDEX,
        { facetName: 'availability', facetQuery: '' },
        viewer
      );
      expect(status).toBe(200);
      const values = (body as { facetHits: { value: string }[] }).facetHits.map((hit) => hit.value);
      expect(values).toEqual(['Public']);
    });

    it('cannot search an index outside the list, or a retired one', async () => {
      for (const index of [UNLISTED_INDEX, IMAGES_SEARCH_INDEX])
        await expect(siteIndexSearch(index, { q: '' }, viewer)).rejects.toMatchObject({
          status: 403,
        });
    });
  });

  it('the owner also finds their own restricted model, and nobody else’s', async () => {
    expect(await search({ userId: OWNER, showSfwFace: false })).toEqual([
      CONTROL,
      RESTRICTED,
      MATURE,
      FACED,
    ]);
  });

  it('civitai.com never serves a mature-only model, whatever the client filters on', async () => {
    expect(await search(signedInOnCom)).toEqual([CONTROL, FACED]);
    expect(await search(signedInOnCom, `nsfwLevel = ${R}`)).toEqual([FACED]);
  });

  it('a .com hit for a model with a face carries the face title and not the .red one', async () => {
    const { body } = await siteIndexSearch(
      MODELS_SEARCH_INDEX,
      { q: 'Title', attributesToHighlight: ['*'] },
      signedInOnCom
    );
    const [hit] = hitsOf(body);
    expect(hit.name).toBe('Com Title');
    expect(JSON.stringify(hit)).not.toContain('Red Title');
  });

  // Either title finds the model on either site; the hit always wears the serving site's title.
  it.each([
    ['Red', 'signed in on .com', 'Com Title'],
    ['Com', 'signed in on .com', 'Com Title'],
    ['Red', 'signed in on .red', 'Red Title'],
    ['Com', 'signed in on .red', 'Red Title'],
  ])('searching "%s" %s finds the faced model as "%s"', async (q, site, shown) => {
    const viewer = site === 'signed in on .com' ? signedInOnCom : signedInOnRed;
    const { body } = await siteIndexSearch(MODELS_SEARCH_INDEX, { q }, viewer);
    const hit = hitsOf(body).find((h) => h.id === FACED);
    expect(hit?.name).toBe(shown);
    expect(JSON.stringify(hit)).not.toContain(shown === 'Com Title' ? 'Red Title' : 'Com Title');
  });

  it('a .red viewer with mature content on keeps the .red title', async () => {
    const { body } = await siteIndexSearch(MODELS_SEARCH_INDEX, { q: 'Title' }, signedInOnRed);
    const [hit] = hitsOf(body);
    expect(hit.name).toBe('Red Title');
    expect(hit).not.toHaveProperty('sfwName');
  });
});
