import { afterEach, describe, expect, it } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { IMAGES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import {
  BROWSER_SEARCH_INDEXES,
  SEARCH_TOKEN_TTL_MS,
  buildSearchRules,
  mintSearchToken,
} from '~/server/meilisearch/search-token';

const PARENT_UID = '6062abda-a5aa-4414-ac91-ecd7944c0f8d';

const decodePayload = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));

afterEach(() => resetEnv());

describe('buildSearchRules', () => {
  const anonModels = '(poi != true) AND (availability != Private)';

  it.each([
    ['anonymous', undefined],
    ['null viewer', null],
    ['a viewer with no id', {}],
    ['a non-integer id', { id: 1.5 }],
    ['a zero id', { id: 0 }],
  ])('%s gets the filters with no owner carve-out', (_label, viewer) => {
    const rules = buildSearchRules(viewer);
    expect(rules[MODELS_SEARCH_INDEX]).toEqual({ filter: anonModels });
    expect(rules[IMAGES_SEARCH_INDEX]).toEqual({ filter: 'poi != true' });
  });

  it('a signed-in user also sees their own models, keyed on user.id', () => {
    const rules = buildSearchRules({ id: 42, isModerator: false });
    expect(rules[MODELS_SEARCH_INDEX]).toEqual({
      filter: '(poi != true OR user.id = 42) AND (availability != Private OR user.id = 42)',
    });
    // Images carry no owner carve-out.
    expect(rules[IMAGES_SEARCH_INDEX]).toEqual({ filter: 'poi != true' });
  });

  it('moderators get no filters on any index', () => {
    const rules = buildSearchRules({ id: 7, isModerator: true });
    expect(Object.values(rules)).toEqual(BROWSER_SEARCH_INDEXES.map(() => ({})));
  });

  it('grants exactly the browser indexes, never a wildcard', () => {
    for (const viewer of [undefined, { id: 42 }, { id: 7, isModerator: true }]) {
      expect(Object.keys(buildSearchRules(viewer)).sort()).toEqual(
        [...BROWSER_SEARCH_INDEXES].sort()
      );
    }
  });
});

describe('mintSearchToken', () => {
  it('returns null while no signing key is configured', () => {
    setEnv({ SEARCH_TOKEN_API_KEY: undefined, SEARCH_TOKEN_API_KEY_UID: undefined });
    expect(mintSearchToken({ id: 42 })).toBeNull();

    setEnv({ SEARCH_TOKEN_API_KEY: 'parent-key', SEARCH_TOKEN_API_KEY_UID: undefined });
    expect(mintSearchToken({ id: 42 })).toBeNull();
  });

  it('signs the viewer rules with the configured key uid and a one-hour expiry', () => {
    setEnv({
      SEARCH_TOKEN_API_KEY: 'parent-key',
      SEARCH_TOKEN_API_KEY_UID: PARENT_UID,
      NEXT_PUBLIC_SEARCH_HOST: 'http://localhost:7700',
    });
    const now = Date.UTC(2026, 9, 20, 3, 0, 0);
    const minted = mintSearchToken({ id: 42 }, now);

    expect(minted?.expiresAt).toBe(now + SEARCH_TOKEN_TTL_MS);
    const payload = decodePayload(minted!.token);
    expect(payload.apiKeyUid).toBe(PARENT_UID);
    expect(payload.exp).toBe(Math.floor((now + SEARCH_TOKEN_TTL_MS) / 1000));
    expect(payload.searchRules).toEqual(buildSearchRules({ id: 42 }));
  });
});
