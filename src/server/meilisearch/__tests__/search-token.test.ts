import { afterEach, describe, expect, it } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { IMAGES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import {
  BROWSER_SEARCH_INDEXES,
  SEARCH_TOKEN_TTL_MS,
  buildSearchRules,
  mintSearchToken,
} from '~/server/meilisearch/search-token';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';
import { RETIRED_SEARCH_INDEXES } from '~/server/search-index/retired-indexes';

const PARENT_UID = '6062abda-a5aa-4414-ac91-ecd7944c0f8d';

const decodePayload = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));

afterEach(() => resetEnv());

describe('buildSearchRules', () => {
  const anonModels = '(poi != true) AND (availability != Private)';
  const viewers = [undefined, { id: 42 }, { id: 7, isModerator: true }];

  it.each([
    ['anonymous', undefined],
    ['null viewer', null],
    ['a viewer with no id', {}],
    ['a non-integer id', { id: 1.5 }],
    ['a zero id', { id: 0 }],
  ])('%s gets the filters with no owner carve-out', (_label, viewer) => {
    expect(buildSearchRules(viewer)[MODELS_SEARCH_INDEX]).toEqual({ filter: anonModels });
    expect(buildSearchRules(viewer, [])[IMAGES_SEARCH_INDEX]).toEqual({ filter: 'poi != true' });
  });

  it('a signed-in user also sees their own models, keyed on user.id', () => {
    const rules = buildSearchRules({ id: 42, isModerator: false }, []);
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
    for (const viewer of viewers) {
      expect(Object.keys(buildSearchRules(viewer)).sort()).toEqual(
        [...BROWSER_SEARCH_INDEXES].sort()
      );
    }
  });

  // A key in the token's rules is a grant, so a retired index must have no key at all: a query
  // on it is refused (403) instead of reaching an index that no longer carries the attributes
  // its filter names.
  it('never grants a retired index', () => {
    expect(RETIRED_SEARCH_INDEXES).toContain(IMAGES_SEARCH_INDEX);
    for (const viewer of viewers) {
      const granted = Object.keys(buildSearchRules(viewer));
      expect(granted.filter((index) => RETIRED_SEARCH_INDEXES.includes(index))).toEqual([]);
      expect(
        BROWSER_SEARCH_INDEXES.filter((index) => RETIRED_SEARCH_INDEXES.includes(index))
      ).toEqual([]);
    }
  });

  it('restoring a retired index grants it with its filter, never without', () => {
    for (const viewer of [undefined, { id: 42 }]) {
      expect(buildSearchRules(viewer, [])[IMAGES_SEARCH_INDEX]).toEqual({ filter: 'poi != true' });
    }
  });

  it('every filter names only attributes its index declares filterable', () => {
    const filterable: Record<string, readonly string[]> = filterableAttributesByIndex;
    const checked: string[] = [];
    for (const viewer of [undefined, { id: 42 }]) {
      for (const [index, rule] of Object.entries(buildSearchRules(viewer, []))) {
        const filter = typeof rule.filter === 'string' ? rule.filter : '';
        for (const [, attribute] of filter.matchAll(/([\w.]+)\s*(?:!=|>=|<=|=|<|>)/g)) {
          expect(filterable[index], `${index}: ${attribute}`).toContain(attribute);
          checked.push(`${index}:${attribute}`);
        }
      }
    }
    // Without this, a filter shape the pattern stopped matching would pass with nothing checked.
    expect(new Set(checked)).toEqual(
      new Set([
        `${MODELS_SEARCH_INDEX}:poi`,
        `${MODELS_SEARCH_INDEX}:availability`,
        `${MODELS_SEARCH_INDEX}:user.id`,
        `${IMAGES_SEARCH_INDEX}:poi`,
      ])
    );
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
    // Signing refuses an expiry in the past, so the clock has to be the real one.
    const now = Date.now();
    const minted = mintSearchToken({ id: 42 }, now);

    expect(minted?.expiresAt).toBe(now + SEARCH_TOKEN_TTL_MS);
    const payload = decodePayload(minted!.token);
    expect(payload.apiKeyUid).toBe(PARENT_UID);
    expect(payload.exp).toBe(Math.floor((now + SEARCH_TOKEN_TTL_MS) / 1000));
    expect(payload.searchRules).toEqual(buildSearchRules({ id: 42 }));
  });
});
