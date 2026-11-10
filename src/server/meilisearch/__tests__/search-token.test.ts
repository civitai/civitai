import { afterEach, describe, expect, it } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
} from '~/server/common/constants';
import {
  BROWSER_SEARCH_INDEXES,
  SEARCH_TOKEN_TTL_MS,
  buildSearchRules,
  mintSearchToken,
} from '~/server/meilisearch/search-token';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';
import { RETIRED_SEARCH_INDEXES } from '~/server/search-index/retired-indexes';
import { indexBrowsingLevelClause } from '~/components/Search/search-filters';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const PARENT_UID = '6062abda-a5aa-4414-ac91-ecd7944c0f8d';

const decodePayload = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));

afterEach(() => resetEnv());

describe('buildSearchRules', () => {
  const anonModels = '(poi != true) AND (availability != Private)';
  // The privacy rules, less the content-level clause the next describe covers.
  const privacy = (rule: { filter?: unknown } | undefined) =>
    String(rule?.filter).replace(/^\((.*)\) AND \(nsfwLevel=[^()]*\)$/, '$1');
  const viewers = [undefined, { id: 42 }, { id: 7, isModerator: true }];

  it.each([
    ['anonymous', undefined],
    ['null viewer', null],
    ['a viewer with no id', {}],
    ['a non-integer id', { id: 1.5 }],
    ['a zero id', { id: 0 }],
  ])('%s gets the filters with no owner carve-out', (_label, viewer) => {
    expect(privacy(buildSearchRules(viewer)[MODELS_SEARCH_INDEX])).toBe(anonModels);
    expect(privacy(buildSearchRules(viewer, [])[IMAGES_SEARCH_INDEX])).toBe('poi != true');
  });

  it('a signed-in user also sees their own models, keyed on user.id', () => {
    const rules = buildSearchRules({ id: 42, isModerator: false }, []);
    expect(privacy(rules[MODELS_SEARCH_INDEX])).toBe(
      '(poi != true OR user.id = 42) AND (availability != Private OR user.id = 42)'
    );
    // Images carry no owner carve-out.
    expect(privacy(rules[IMAGES_SEARCH_INDEX])).toBe('poi != true');
  });

  it('moderators on an uncapped site get no filters on any index', () => {
    const rules = buildSearchRules({ id: 7, isModerator: true, browsingLevelCap: null });
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
      expect(privacy(buildSearchRules(viewer, [])[IMAGES_SEARCH_INDEX])).toBe('poi != true');
    }
  });

  it('every filter names only attributes its index declares filterable', () => {
    const filterable: Record<string, readonly string[]> = filterableAttributesByIndex;
    const checked: string[] = [];
    for (const viewer of [undefined, { id: 42 }]) {
      for (const [index, rule] of Object.entries(buildSearchRules(viewer, []))) {
        const filter = typeof rule.filter === 'string' ? rule.filter : '';
        for (const [, attribute] of filter.matchAll(/([\w.]+)\s*(?:!=|>=|<=|=|<|>|IS |NOT IN)/g)) {
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
        ...LEVELLED_INDEXES.map((index) => `${index}:nsfwLevel`),
      ])
    );
  });
});

const LEVELLED_INDEXES = [
  MODELS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
];

describe('buildSearchRules: the site content level', () => {
  // Each levelled index gets its privacy rules (as on an uncapped site) ANDed with the clause the
  // site-search proxy applies; the opt-in real-Meilisearch test shows Meilisearch enforcing it.
  type Viewer = Parameters<typeof buildSearchRules>[0];
  const expectedRules = (viewer: Viewer, cap: number) => {
    const uncapped = buildSearchRules(
      viewer ? { ...viewer, browsingLevelCap: null } : { browsingLevelCap: null },
      []
    );
    return Object.fromEntries(
      Object.entries(uncapped).map(([index, rule]) => {
        const clause = LEVELLED_INDEXES.includes(index)
          ? indexBrowsingLevelClause(index, cap)
          : null;
        if (!clause) return [index, rule];
        return [index, { filter: rule.filter ? `(${rule.filter}) AND (${clause})` : clause }];
      })
    );
  };

  it('a capped site holds every levelled index to its cap, moderators included', () => {
    for (const isModerator of [false, true]) {
      const viewer = { id: 42, isModerator, browsingLevelCap: publicBrowsingLevelsFlag };
      expect(buildSearchRules(viewer, [])).toEqual(expectedRules(viewer, publicBrowsingLevelsFlag));
    }
  });

  it.each([
    [
      'a signed-in viewer, capped to PG',
      { id: 42, browsingLevelCap: publicBrowsingLevelsFlag },
      '((poi != true OR user.id = 42) AND (availability != Private OR user.id = 42)) AND (nsfwLevel=1)',
      '(poi != true) AND (nsfwLevel=1)',
      'nsfwLevel IS NOT EMPTY AND nsfwLevel NOT IN [2, 4, 8, 16, 32]',
    ],
    [
      'a moderator, capped to PG',
      { id: 7, isModerator: true, browsingLevelCap: publicBrowsingLevelsFlag },
      'nsfwLevel=1',
      'nsfwLevel=1',
      'nsfwLevel IS NOT EMPTY AND nsfwLevel NOT IN [2, 4, 8, 16, 32]',
    ],
    [
      'a moderator with no cap (fails closed to SFW)',
      { id: 7, isModerator: true },
      'nsfwLevel=1 OR nsfwLevel=2',
      'nsfwLevel=1 OR nsfwLevel=2',
      'nsfwLevel IS NOT EMPTY AND nsfwLevel NOT IN [4, 8, 16, 32]',
    ],
  ])('pins the filters for %s', (_label, viewer, models, images, comics) => {
    const rules = buildSearchRules(viewer, []);
    expect(rules[MODELS_SEARCH_INDEX]).toEqual({ filter: models });
    expect(rules[IMAGES_SEARCH_INDEX]).toEqual({ filter: images });
    expect(rules[COMICS_SEARCH_INDEX]).toEqual({ filter: comics });
  });

  it('pins the clause for a levelled index and none for an index with no level', () => {
    const rules = buildSearchRules({ browsingLevelCap: publicBrowsingLevelsFlag }, []);
    expect(rules[ARTICLES_SEARCH_INDEX]).toEqual({ filter: 'nsfwLevel=1' });
    for (const index of BROWSER_SEARCH_INDEXES.filter((i) => !LEVELLED_INDEXES.includes(i)))
      expect(rules[index], index).toEqual({});
  });

  it('a missing or unusable cap fails closed to the SFW cap', () => {
    const viewers = [
      null,
      undefined,
      { id: 42 },
      ...[0, -1, 1.5, NaN, '31'].map((browsingLevelCap) => ({
        id: 42,
        browsingLevelCap: browsingLevelCap as number,
      })),
    ];
    for (const viewer of viewers)
      expect(buildSearchRules(viewer, []), JSON.stringify(viewer)).toEqual(
        expectedRules(viewer, sfwBrowsingLevelsFlag)
      );
  });

  it('an uncapped site adds no level clause', () => {
    const rules = buildSearchRules({ id: 42, browsingLevelCap: null }, []);
    expect(JSON.stringify(rules)).not.toContain('nsfwLevel');
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
