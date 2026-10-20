import { MeiliSearch } from 'meilisearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { IMAGES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import {
  BROWSER_SEARCH_INDEXES,
  SEARCH_TOKEN_TTL_MS,
  mintSearchToken,
} from '~/server/meilisearch/search-token';

/**
 * Search tokens against a REAL Meilisearch: the rules only mean anything if Meilisearch enforces
 * them, which no mock can show. Opt-in, because it needs a running instance:
 *
 *   docker run -d -p 7719:7700 -e MEILI_MASTER_KEY=<key> getmeili/meilisearch:v1.11
 *   MEILI_IT_HOST=http://127.0.0.1:7719 MEILI_IT_MASTER_KEY=<key> \
 *     pnpm exec vitest run --project 'unit*' src/server/meilisearch/__tests__/search-token.meili.integration.test.ts
 *
 * It creates and deletes its own indexes and keys, so point it at a throwaway instance only.
 */
const HOST = process.env.MEILI_IT_HOST;
const MASTER_KEY = process.env.MEILI_IT_MASTER_KEY;

const CONTROL = 1;
const RESTRICTED = 2; // poi, owned by OWNER
const PRIVATE = 3;
const OWNER = 7;
const OTHER_USER = 99;
const CONTROL_IMAGE = 10;
const RESTRICTED_IMAGE = 11;
// An index the browser never searches: a token must not reach it.
const UNLISTED_INDEX = 'models';
// Retired, so no token grants it.
const RETIRED_INDEX = IMAGES_SEARCH_INDEX;

const modelDocs = [
  { id: CONTROL, name: 'Control', poi: false, availability: 'Public', user: { id: 5 } },
  { id: RESTRICTED, name: 'Restricted', poi: true, availability: 'Public', user: { id: OWNER } },
  { id: PRIVATE, name: 'Private', poi: false, availability: 'Private', user: { id: 9 } },
];
const imageDocs = [
  { id: CONTROL_IMAGE, poi: false, user: { id: 5 } },
  { id: RESTRICTED_IMAGE, poi: true, user: { id: OWNER } },
];

async function call(key: string, path: string, body?: unknown) {
  const res = await fetch(`${HOST}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function searchIds(key: string, index: string, filter?: string) {
  const { status, body } = await call(key, `/indexes/${index}/search`, { q: '', filter });
  expect(status, JSON.stringify(body)).toBe(200);
  return (body.hits as { id: number }[]).map((hit) => hit.id).sort();
}

describe.skipIf(!HOST || !MASTER_KEY)('search tokens on a real Meilisearch', () => {
  let admin: MeiliSearch;
  let plainKey: string; // A search key with no rules: the fixture control.
  let plainKeyUid: string;
  let parentKeyUid: string;

  const tokenFor = (viewer: Parameters<typeof mintSearchToken>[0], now?: number) =>
    mintSearchToken(viewer, now)!.token;

  beforeAll(async () => {
    admin = new MeiliSearch({ host: HOST!, apiKey: MASTER_KEY });
    for (const index of [...BROWSER_SEARCH_INDEXES, RETIRED_INDEX, UNLISTED_INDEX])
      await admin.waitForTask((await admin.deleteIndex(index)).taskUid);

    const models = admin.index(MODELS_SEARCH_INDEX);
    await admin.waitForTask(
      (
        await models.updateFilterableAttributes(['id', 'poi', 'availability', 'user.id'])
      ).taskUid
    );
    await admin.waitForTask((await models.addDocuments(modelDocs)).taskUid);
    const images = admin.index(RETIRED_INDEX);
    await admin.waitForTask((await images.updateFilterableAttributes(['id', 'poi'])).taskUid);
    await admin.waitForTask((await images.addDocuments(imageDocs)).taskUid);
    await admin.waitForTask((await admin.index(UNLISTED_INDEX).addDocuments(modelDocs)).taskUid);

    const legacy = await admin.createKey({
      description: 'integration: search key with no rules',
      actions: ['search'],
      indexes: ['*'],
      expiresAt: null,
    });
    plainKey = legacy.key;
    plainKeyUid = legacy.uid;

    const parent = await admin.createKey({
      description: 'integration: search token signing key',
      actions: ['search'],
      // The parent key still reaches the retired index, so a refusal there comes from the token.
      indexes: [...BROWSER_SEARCH_INDEXES, RETIRED_INDEX],
      expiresAt: null,
    });
    parentKeyUid = parent.uid;
    setEnv({
      SEARCH_TOKEN_API_KEY: parent.key,
      SEARCH_TOKEN_API_KEY_UID: parent.uid,
      NEXT_PUBLIC_SEARCH_HOST: HOST,
    });
  });

  afterAll(async () => {
    if (!admin) return;
    for (const uid of [plainKeyUid, parentKeyUid]) await admin.deleteKey(uid).catch(() => null);
    for (const index of [...BROWSER_SEARCH_INDEXES, RETIRED_INDEX, UNLISTED_INDEX])
      await admin.deleteIndex(index).catch(() => null);
  });

  // Without this, every empty result below could mean the fixture never indexed anything.
  it('fixture control: a key with no rules sees every document', async () => {
    expect(await searchIds(plainKey, MODELS_SEARCH_INDEX)).toEqual([CONTROL, RESTRICTED, PRIVATE]);
    expect(await searchIds(plainKey, RETIRED_INDEX)).toEqual([CONTROL_IMAGE, RESTRICTED_IMAGE]);
  });

  describe.each([
    ['anonymous', null],
    ['a signed-in non-moderator', { id: OTHER_USER, isModerator: false }],
  ])('token for %s', (_label, viewer) => {
    it('still finds the control model', async () => {
      expect(await searchIds(tokenFor(viewer), MODELS_SEARCH_INDEX)).toEqual([CONTROL]);
    });

    it.each([
      ['poi = true', MODELS_SEARCH_INDEX],
      [`id = ${RESTRICTED}`, MODELS_SEARCH_INDEX],
      [`id = ${PRIVATE}`, MODELS_SEARCH_INDEX],
      [`availability = Private`, MODELS_SEARCH_INDEX],
    ])('filter "%s" on %s finds nothing', async (filter, index) => {
      expect(await searchIds(tokenFor(viewer), index, filter)).toEqual([]);
    });

    it('multi-search (what the browser sends) is held to the same rules', async () => {
      const { status, body } = await call(tokenFor(viewer), '/multi-search', {
        queries: [{ indexUid: MODELS_SEARCH_INDEX, q: '', filter: 'poi = true' }],
      });
      expect(status).toBe(200);
      expect(body.results[0].hits).toEqual([]);
    });

    it('cannot read documents or search an index outside the list', async () => {
      const token = tokenFor(viewer);
      for (const path of [
        `/indexes/${MODELS_SEARCH_INDEX}/documents/${RESTRICTED}`,
        `/indexes/${MODELS_SEARCH_INDEX}/documents`,
      ])
        expect((await call(token, path)).status).toBe(403);
      expect((await call(token, `/indexes/${UNLISTED_INDEX}/search`, { q: '' })).status).toBe(403);
    });

    it('cannot search a retired index', async () => {
      const token = tokenFor(viewer);
      expect((await call(token, `/indexes/${RETIRED_INDEX}/search`, { q: '' })).status).toBe(403);
      const { status } = await call(token, '/multi-search', {
        queries: [{ indexUid: RETIRED_INDEX, q: '' }],
      });
      expect(status).toBe(403);
    });
  });

  it('the owner also finds their own restricted model, and nobody else’s', async () => {
    const token = tokenFor({ id: OWNER, isModerator: false });
    expect(await searchIds(token, MODELS_SEARCH_INDEX)).toEqual([CONTROL, RESTRICTED]);
  });

  it('a moderator token finds every model, but not a retired index', async () => {
    const token = tokenFor({ id: 1, isModerator: true });
    expect(await searchIds(token, MODELS_SEARCH_INDEX)).toEqual([CONTROL, RESTRICTED, PRIVATE]);
    expect((await call(token, `/indexes/${RETIRED_INDEX}/search`, { q: '' })).status).toBe(403);
  });

  it('an expired token is refused', async () => {
    // Signing refuses a past expiry, so mint one that lapses in a second and wait it out.
    const token = tokenFor(null, Date.now() - SEARCH_TOKEN_TTL_MS + 1000);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await call(token, `/indexes/${MODELS_SEARCH_INDEX}/search`, { q: '' })).status).toBe(
      403
    );
  });

  it('a deleted key is refused', async () => {
    await admin.deleteKey(plainKeyUid);
    const { status } = await call(plainKey, `/indexes/${MODELS_SEARCH_INDEX}/search`, { q: '' });
    expect([401, 403]).toContain(status);
  });
});
