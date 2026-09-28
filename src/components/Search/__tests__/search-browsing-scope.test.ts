// @vitest-environment happy-dom
import { act, createElement } from 'react';
import type React from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { createRoot } from 'react-dom/client';
import type * as ReactInstantsearch from 'react-instantsearch';
import { describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { buildAutocompleteBaseFilters } from '~/components/AutocompleteSearch/autocomplete-filters';
import {
  BrowsingLevelProvider,
  BrowsingLevelProviderOptional,
  useBrowsingLevelDebounced,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingLevelFilter } from '~/components/Search/CustomSearchComponents';
import { SearchBrowsingScope } from '~/components/Search/SearchBrowsingScope';
import {
  BrowsingSettingsAddonsProvider,
  useBrowsingSettingsAddons,
} from '~/providers/BrowsingSettingsAddonsProvider';
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

const configured: { filters?: string }[] = [];
vi.mock('react-instantsearch', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactInstantsearch>()),
  useConfigure: (props: { filters?: string }) => {
    configured.push(props);
    return {};
  },
}));

type Seen = { level: number; levelFilter?: string; baseFilters: string[]; disableMinor: boolean };

/**
 * `_app`'s tree: the page override wraps the addons provider, and both wrap the whole AppLayout,
 * header search included. The homepage's override is PG.
 */
function renderSearch({ scoped }: { scoped: boolean }) {
  configured.length = 0;
  const seen = {} as Seen;

  function Probe() {
    const level = useBrowsingLevelDebounced();
    const addons = useBrowsingSettingsAddons().settings;
    seen.level = level;
    seen.disableMinor = addons.disableMinor;
    seen.baseFilters = buildAutocompleteBaseFilters({
      targetIndex: 'models',
      addons,
      currentUser: viewer,
    });
    expect(addons, 'addons must be resolved at the level the search filters on').toEqual(
      resolveBrowsingSettingsAddons(DEFAULT_BROWSING_SETTINGS_ADDONS, level)
    );
    return createElement(BrowsingLevelFilter, { indexKey: 'models' });
  }

  const search: React.ReactElement = scoped
    ? createElement(SearchBrowsingScope, null, createElement(Probe))
    : createElement(Probe);

  const root = createRoot(document.createElement('div'));
  act(() => {
    root.render(
      createElement(
        BrowsingLevelProvider,
        null,
        createElement(
          BrowsingLevelProviderOptional,
          { browsingLevel: publicBrowsingLevelsFlag },
          createElement(BrowsingSettingsAddonsProvider, null, search)
        )
      )
    );
  });
  act(() => root.unmount());
  seen.levelFilter = configured.at(-1)?.filters;
  return seen;
}

const ALL_LEVELS_FILTER =
  '(nsfwLevel=1 OR nsfwLevel=2 OR nsfwLevel=4 OR nsfwLevel=8 OR nsfwLevel=16)';

describe('SearchBrowsingScope', () => {
  it('searches at the viewer level under a PG page override, with the minor and POI exclusions', () => {
    canViewNsfw.value = true;
    const seen = renderSearch({ scoped: true });

    expect(seen.level).toBe(allBrowsingLevelsFlag);
    expect(seen.levelFilter).toBe(ALL_LEVELS_FILTER);
    expect(seen.baseFilters).toContain('minor != true');
    expect(seen.baseFilters).toContain('poi != true OR user.id = 1');
  });

  /**
   * Also the fixture's positive control: without the scope, the override does reach search.
   *
   * 🔴 BrowsingLevelFilter reads the PAGE level on purpose. Switching it to the viewer hook widens
   * the level filter alone, while the addons in the same tree stay at the page level with the
   * minor exclusion off. Widen a search by wrapping it in SearchBrowsingScope instead.
   */
  it('keeps the level filter and the addons on one level when unscoped', () => {
    canViewNsfw.value = true;
    const seen = renderSearch({ scoped: false });

    expect(seen.levelFilter, 'the level filter must not widen without its addons').toBe(
      '(nsfwLevel=1)'
    );
    expect(seen.disableMinor).toBe(false);
  });

  it('keeps the domain cap', () => {
    canViewNsfw.value = false;
    const seen = renderSearch({ scoped: true });

    expect(seen.level).toBe(sfwBrowsingLevelsFlag);
    expect(seen.levelFilter).toBe('(nsfwLevel=1 OR nsfwLevel=2)');
  });
});

/**
 * The two search roots rendered inside page layouts. Each export must be the scoped wrapper; a
 * root outside it reads the page override again, which on the homepage is PG.
 */
describe.each([
  ['AutocompleteSearch', ['..', '..', 'AutocompleteSearch', 'AutocompleteSearch.tsx']],
  ['QuickSearchDropdown', ['..', 'QuickSearchDropdown.tsx']],
])('%s', (name, file) => {
  it('exports the SearchBrowsingScope wrapper', () => {
    const source = readFileSync(path.resolve(__dirname, ...file), 'utf-8');
    const exported = source.slice(source.indexOf(`export const ${name} =`));

    expect(exported.slice(0, 200)).toContain('<SearchBrowsingScope>');
  });
});
