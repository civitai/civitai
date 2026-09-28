// @vitest-environment happy-dom
import * as React from 'react';
import { createElement } from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as ReactInstantsearch from 'react-instantsearch';
import { describe, expect, it, vi } from 'vitest';
import { BrowsingModeOverrideCtx } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingLevelFilter } from '~/components/Search/CustomSearchComponents';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const configured: { filters?: string }[] = [];

vi.mock('react-instantsearch', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactInstantsearch>()),
  useConfigure: (props: { filters?: string }) => {
    configured.push(props);
    return {};
  },
}));

type Ctx = {
  forcedBrowsingLevel?: number;
  browsingLevelOverride?: number;
  userBrowsingLevel: number;
};

function renderFilter(ctx: Ctx) {
  configured.length = 0;
  const root = createRoot(document.createElement('div'));
  act(() => {
    root.render(
      createElement(
        BrowsingModeOverrideCtx.Provider,
        { value: { ...ctx, blurLevels: 0 } },
        createElement(BrowsingLevelFilter, { indexKey: 'models' })
      )
    );
  });
  act(() => root.unmount());
  return configured.at(-1)?.filters;
}

/**
 * Search is a list of other people's content, so its filter follows the VIEWER, not the page.
 * The homepage passes a PG override for its own feed, and `_app` applies that override around
 * the whole AppLayout, header search included. Reading the page level here made the header
 * autocomplete PG-only on the homepage for every viewer.
 */
describe('BrowsingLevelFilter', () => {
  it('ignores a PG page override for a viewer who browses every level', () => {
    const filters = renderFilter({
      browsingLevelOverride: publicBrowsingLevelsFlag,
      userBrowsingLevel: allBrowsingLevelsFlag,
    });

    expect(filters).toBe(
      '(nsfwLevel=1 OR nsfwLevel=2 OR nsfwLevel=4 OR nsfwLevel=8 OR nsfwLevel=16)'
    );
  });

  it('still applies the forced (domain) cap', () => {
    const filters = renderFilter({
      forcedBrowsingLevel: sfwBrowsingLevelsFlag,
      browsingLevelOverride: publicBrowsingLevelsFlag,
      userBrowsingLevel: allBrowsingLevelsFlag,
    });

    expect(filters).toBe('(nsfwLevel=1 OR nsfwLevel=2)');
  });
});
