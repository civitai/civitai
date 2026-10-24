// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import type { ReactNode } from 'react';
import { act, createElement, Fragment } from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { createRoot } from 'react-dom/client';
import type * as InstantMeilisearch from '@meilisearch/instant-meilisearch';
import type * as ReactInstantsearch from 'react-instantsearch';
import { describe, expect, it, vi } from 'vitest';
import type * as HiddenPreferencesModule from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import type * as Trpc from '~/utils/trpc';
import { buildAutocompleteBaseFilters } from '~/components/AutocompleteSearch/autocomplete-filters';
import {
  BrowsingLevelProvider,
  BrowsingLevelProviderOptional,
  useBrowsingLevelDebounced,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { BrowsingLevelFilter } from '~/components/Search/CustomSearchComponents';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { withSearchBrowsingScope } from '~/components/Search/SearchBrowsingScope';
import {
  BrowsingSettingsAddonsProvider,
  useBrowsingSettingsAddons,
} from '~/providers/BrowsingSettingsAddonsProvider';
import { NsfwLevel } from '~/server/common/enums';
import {
  DEFAULT_BROWSING_SETTINGS_ADDONS,
  resolveBrowsingSettingsAddons,
} from '~/shared/constants/browsing-settings-addons';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewer = { id: 1, username: 'viewer', isModerator: false };
const canViewNsfw = { value: true };
const settings = { showNsfw: true, browsingLevel: allBrowsingLevelsFlag, blurNsfw: false };

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: canViewNsfw.value }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (select: (state: typeof settings) => unknown) => select(settings),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    system: {
      getBrowsingSettingAddons: {
        useQuery: () => ({ data: DEFAULT_BROWSING_SETTINGS_ADDONS, isLoading: false }),
      },
    },
  },
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferencesModule>()),
  useHiddenPreferencesContext: () => ({
    hiddenUsers: new Map(),
    blockRelations: new Map(),
    hiddenTags: new Map(),
    hiddenModels: new Map(),
    hiddenModel3Ds: new Map(),
    hiddenImages: new Map(),
    hiddenLoading: false,
    moderatedTags: [],
    systemHiddenTags: new Map(),
  }),
}));

// The search host is unset under test, and the dropdown builds its client from it at import time.
vi.mock('@meilisearch/instant-meilisearch', async (importOriginal) => ({
  ...(await importOriginal<typeof InstantMeilisearch>()),
  instantMeiliSearch: () => ({ search: async () => ({ results: [] }) }),
}));

const configured: { filters?: string }[] = [];
vi.mock('react-instantsearch', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactInstantsearch>()),
  useConfigure: (props: { filters?: string }) => {
    configured.push(props);
    return {};
  },
  InstantSearch: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
  useSearchBox: () => ({ query: '', refine: () => undefined, isSearchStalled: false }),
  useHits: () => ({ hits: [], results: undefined }),
}));

const modelHit = (id: number, minor: boolean) => ({
  id,
  name: `model ${id}`,
  nsfw: false,
  nsfwLevel: NsfwLevel.R,
  minor,
  user: { id: 2 },
  tags: [],
  images: [{ id: id * 100, userId: 2, nsfwLevel: NsfwLevel.R, tags: [] }],
});
const ADULT_R_MODEL = 10;
const MINOR_R_MODEL = 11;

type Seen = { level: number; sentFilter?: string; disableMinor: boolean; keptModelIds: number[] };

/**
 * Stands in for the search internals: the three readers that derive from the level. The base
 * filters go into BrowsingLevelFilter the way AutocompleteSearch passes them, so `sentFilter` is
 * the one string that reaches Meilisearch.
 */
function Probe({ seen }: { seen: Seen }) {
  const level = useBrowsingLevelDebounced();
  const addons = useBrowsingSettingsAddons().settings;
  const { items } = useApplyHiddenPreferences({
    type: 'models',
    data: [modelHit(ADULT_R_MODEL, false), modelHit(MINOR_R_MODEL, true)] as never,
  });

  expect(addons, 'addons must be resolved at the level the search filters on').toEqual(
    resolveBrowsingSettingsAddons(DEFAULT_BROWSING_SETTINGS_ADDONS, level)
  );
  seen.level = level;
  seen.disableMinor = addons.disableMinor;
  seen.keptModelIds = (items as { id: number }[]).map((x) => x.id);

  return createElement(BrowsingLevelFilter, {
    indexKey: 'models',
    filters: buildAutocompleteBaseFilters({ targetIndex: 'models', addons, currentUser: viewer }),
  });
}

const ScopedProbe = withSearchBrowsingScope(Probe);

/** Mirrors `_app`: page override > addons provider > layout (header search). Homepage override is PG. */
function renderSearch({ scoped }: { scoped: boolean }) {
  configured.length = 0;
  const seen = {} as Seen;

  const root = createRoot(document.createElement('div'));
  act(() => {
    root.render(
      createElement(
        BrowsingLevelProvider,
        null,
        createElement(
          BrowsingLevelProviderOptional,
          { browsingLevel: publicBrowsingLevelsFlag },
          createElement(
            BrowsingSettingsAddonsProvider,
            null,
            createElement(scoped ? ScopedProbe : Probe, { seen })
          )
        )
      )
    );
  });
  act(() => root.unmount());
  seen.sentFilter = configured.at(-1)?.filters;
  return seen;
}

describe('withSearchBrowsingScope', () => {
  it('searches at the viewer level under a PG page override, keeping the minor exclusion', () => {
    canViewNsfw.value = true;
    const seen = renderSearch({ scoped: true });

    expect(seen.level).toBe(allBrowsingLevelsFlag);
    expect(seen.sentFilter).toBe(
      '(poi != true OR user.id = 1) AND (minor != true OR user.id = 1) AND (availability != Private OR user.id = 1)' +
        ' AND (nsfwLevel=1 OR nsfwLevel=2 OR nsfwLevel=4 OR nsfwLevel=8 OR nsfwLevel=16)'
    );
    expect(seen.keptModelIds, 'hidden prefs: R model kept, minor-flagged R model dropped').toEqual([
      ADULT_R_MODEL,
    ]);
  });

  /**
   * The fixture's positive control: unscoped, the page override reaches search. Only the minor
   * exclusion discriminates here; the default POI rule applies at PG as well.
   *
   * 🔴 BrowsingLevelFilter reads the level of its nearest addons provider on purpose; switching it
   * to the viewer hook widens the level filter while the addons stay at PG. Widen a search with
   * withSearchBrowsingScope instead.
   */
  it('keeps the level filter and the addons on one level when unscoped', () => {
    canViewNsfw.value = true;
    const seen = renderSearch({ scoped: false });

    expect(seen.sentFilter, 'the level filter must not widen without its addons').toBe(
      '(poi != true OR user.id = 1) AND (availability != Private OR user.id = 1) AND (nsfwLevel=1)'
    );
    expect(seen.disableMinor).toBe(false);
    expect(seen.keptModelIds).toEqual([]);
  });

  it('keeps the domain cap', () => {
    canViewNsfw.value = false;
    const seen = renderSearch({ scoped: true });

    expect(seen.level).toBe(sfwBrowsingLevelsFlag);
    expect(seen.sentFilter).toMatch(/ AND \(nsfwLevel=1 OR nsfwLevel=2\)$/);
  });
});

/**
 * Each export must be built by the HOC. A hand-written wrapper could read the level or the addons
 * above the scope; the HOC's body is fixed.
 */
describe.each([
  ['AutocompleteSearch', ['..', '..', 'AutocompleteSearch', 'AutocompleteSearch.tsx']],
  ['QuickSearchDropdown', ['..', 'QuickSearchDropdown.tsx']],
])('%s', (name, file) => {
  it('is exported through withSearchBrowsingScope', () => {
    const source = readFileSync(path.resolve(__dirname, ...file), 'utf-8');

    expect(source.match(new RegExp(String.raw`^export const ${name} = .*$`, 'gm'))).toEqual([
      `export const ${name} = withSearchBrowsingScope(${name}Inner);`,
    ]);
  });
});

const NSFW_LEVEL_TERM = /\bnsfwLevel=(?:4|8|16|32)\b/;
const MINOR_CLAUSE = '(minor != true OR user.id = 1)';
const ALL_LEVELS_WITH_MINOR_EXCLUSION = `${MINOR_CLAUSE} AND (nsfwLevel=1 OR nsfwLevel=2 OR nsfwLevel=4 OR nsfwLevel=8 OR nsfwLevel=16)`;

function quickSearchTree() {
  return createElement(
    MantineProvider,
    null,
    createElement(
      BrowsingLevelProvider,
      null,
      createElement(
        BrowsingSettingsAddonsProvider,
        null,
        createElement(QuickSearchDropdown, {
          supportedIndexes: ['models'],
          onItemSelected: () => undefined,
        })
      )
    )
  );
}

describe('QuickSearchDropdown', () => {
  it('sends the minor exclusion to Meilisearch, not only to the client-side filter', () => {
    canViewNsfw.value = true;
    configured.length = 0;
    const root = createRoot(document.createElement('div'));
    act(() => root.render(quickSearchTree()));
    act(() => root.unmount());

    expect(configured.at(-1)?.filters).toBe(ALL_LEVELS_WITH_MINOR_EXCLUSION);
  });

  /**
   * 🔴 The level filter must read the level the addons provider resolved, not debounce the level a
   * second time. Two debounces are two timers, and the render between them sends NSFW levels with
   * the PG addons, which carry no minor exclusion.
   *
   * The timers are queued by hand and each fires in its own act(), so that render is observable.
   * vi's fake timers cannot do this: timers due at the same instant all fire in one advance, and
   * one act() batches their updates into a single render, which passes with the race still there.
   */
  it('never sends an NSFW level without the minor exclusion while the level rises', () => {
    canViewNsfw.value = true;
    const timers = new Map<number, () => void>();
    let nextTimerId = 0;
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((cb: () => void) => {
      timers.set(++nextTimerId, cb);
      return nextTimerId;
    }) as never);
    const clearTimeoutSpy = vi
      .spyOn(window, 'clearTimeout')
      .mockImplementation(((id: number) => timers.delete(id)) as never);
    const root = createRoot(document.createElement('div'));
    try {
      settings.browsingLevel = publicBrowsingLevelsFlag;
      configured.length = 0;
      act(() => root.render(quickSearchTree()));
      expect(configured.at(-1)?.filters, 'starts at PG, where no minor exclusion applies').toBe(
        '(nsfwLevel=1)'
      );

      settings.browsingLevel = allBrowsingLevelsFlag;
      act(() => root.render(quickSearchTree()));
      let fired = 0;
      for (const [id, cb] of timers) {
        timers.delete(id);
        act(() => cb());
        expect(++fired, 'the timers must drain').toBeLessThan(20);
      }
      expect(fired, 'each debounce timer fired in its own render').toBeGreaterThan(1);

      const sent = configured.map((c) => c.filters ?? '');
      expect(NSFW_LEVEL_TERM.test(ALL_LEVELS_WITH_MINOR_EXCLUSION), 'the probe matches').toBe(true);
      const unsafe = sent.filter((f) => NSFW_LEVEL_TERM.test(f) && !f.includes('(minor != true'));
      expect(unsafe.join('\n'), 'NSFW levels sent without the minor exclusion').toBe('');
      expect(sent.at(-1), 'the level change must have reached the filter').toBe(
        ALL_LEVELS_WITH_MINOR_EXCLUSION
      );
    } finally {
      act(() => root.unmount());
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      settings.browsingLevel = allBrowsingLevelsFlag;
    }
  });
});
