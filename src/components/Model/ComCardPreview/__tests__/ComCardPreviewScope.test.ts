// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowsingLevelProvider,
  useBrowsingLevelDebounced,
  useViewerBrowsingLevelDebounced,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import {
  ComCardPreviewScope,
  useComCardBrowsingLevel,
} from '~/components/Model/ComCardPreview/ComCardPreview';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

// A signed-in viewer; `canViewNsfw` true is civitai.red, false is civitai.com.
const site = { canViewNsfw: true };
const settings = { showNsfw: true, browsingLevel: allBrowsingLevelsFlag, blurNsfw: false };

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: site.canViewNsfw }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (select: (state: typeof settings) => unknown) => select(settings),
}));
vi.mock('~/providers/AppProvider', () => ({ useServerDomains: () => ({}) }));
vi.mock('~/hooks/useSyncAccount', () => ({ useSyncAccount: () => (x: string) => x }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Seen = { page: number; viewer: number; hero: number | undefined; mounts: number };

function setup() {
  const seen: Seen = { page: 0, viewer: 0, hero: undefined, mounts: 0 };
  const root = createRoot(document.createElement('div'));

  // The hero level is read the way the model page reads it: above the scope.
  function Page({ previewing, scoped }: { previewing: boolean; scoped: boolean }) {
    seen.hero = useComCardBrowsingLevel(previewing);
    const body = createElement(Body);
    // eslint-disable-next-line react/no-children-prop -- ComCardPreviewScope requires children in its props type
    return scoped ? createElement(ComCardPreviewScope, { previewing, children: body }) : body;
  }
  function Body() {
    seen.page = useBrowsingLevelDebounced();
    seen.viewer = useViewerBrowsingLevelDebounced();
    useEffect(() => {
      seen.mounts += 1;
    }, []);
    return null;
  }
  const render = (previewing: boolean, scoped = true) =>
    act(() => {
      root.render(
        createElement(BrowsingLevelProvider, null, createElement(Page, { previewing, scoped }))
      );
    });
  return { seen, render, unmount: () => act(() => root.unmount()) };
}

describe('ComCardPreviewScope', () => {
  afterEach(() => {
    vi.useRealTimers();
    site.canViewNsfw = true;
    settings.browsingLevel = allBrowsingLevelsFlag;
  });

  it('reads the page at the level civitai.com would serve this viewer while previewing', () => {
    site.canViewNsfw = false;
    const com = setup();
    com.render(false, false);
    const comLevel = com.seen.page;
    com.unmount();
    expect(comLevel).toBe(sfwBrowsingLevelsFlag);

    site.canViewNsfw = true;
    const red = setup();
    red.render(true);
    expect(red.seen.page).toBe(comLevel);
    expect(red.seen.viewer).toBe(comLevel);
    expect(red.seen.hero).toBe(comLevel);
    red.unmount();
  });

  it('leaves the civitai.red level alone when not previewing', () => {
    const red = setup();
    red.render(false);
    expect(red.seen.page).toBe(allBrowsingLevelsFlag);
    expect(red.seen.viewer).toBe(allBrowsingLevelsFlag);
    expect(red.seen.hero).toBeUndefined();
    red.unmount();
  });

  it('switches both ways without remounting the page body', () => {
    vi.useFakeTimers();
    const red = setup();
    red.render(false);
    red.render(true);
    act(() => void vi.advanceTimersByTime(1000));
    expect(red.seen.page).toBe(sfwBrowsingLevelsFlag);
    red.render(false);
    act(() => void vi.advanceTimersByTime(1000));
    expect(red.seen.page).toBe(allBrowsingLevelsFlag);
    expect(red.seen.mounts).toBe(1);
    red.unmount();
  });

  it('serves a viewer with a stricter saved level what civitai.com serves them', () => {
    settings.browsingLevel = publicBrowsingLevelsFlag;
    site.canViewNsfw = false;
    const com = setup();
    com.render(false, false);
    const comLevel = com.seen.page;
    com.unmount();
    // The cap replaces a stricter saved level, as it does on civitai.com.
    expect(comLevel).toBe(sfwBrowsingLevelsFlag);

    site.canViewNsfw = true;
    const red = setup();
    red.render(true);
    expect(red.seen.page).toBe(comLevel);
    expect(red.seen.hero).toBe(comLevel);
    red.unmount();
  });
});
