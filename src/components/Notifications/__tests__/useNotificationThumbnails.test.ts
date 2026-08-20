// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The hook's own filter is the ONLY thing standing between a raw Image row and
 * the panel: the `Image` arm of `getEntitiesCoverImage` is an identity select,
 * gated by nothing but `ingestion = 'Scanned' AND needsReview IS NULL`. So this
 * suite leaves `useApplyHiddenPreferences` real and mocks only what it reads
 * from React context — mocking the filter would leave the gate untested and the
 * suite green, which is the failure this file exists to prevent.
 */
const state = vi.hoisted(() => ({
  hiddenTags: new Map<number, boolean>(),
  browsingLevel: 1,
  images: [] as Record<string, unknown>[],
  useQuery: vi.fn(),
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => state.browsingLevel,
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', () => ({
  useHiddenPreferencesContext: () => ({
    hiddenUsers: new Map(),
    hiddenTags: state.hiddenTags,
    hiddenModels: new Map(),
    hiddenModel3Ds: new Map(),
    hiddenImages: new Map(),
    hiddenLoading: false,
    moderatedTags: [],
    systemHiddenTags: new Map(),
  }),
}));
// Never the owner and never a moderator. Both of those bypass the level gate
// for an unrated image, so a viewer who is either turns every drop assertion
// below into one that passes on a gutted filter.
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 999, isModerator: false }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  useBrowsingSettingsAddons: () => ({ settings: { disablePoi: false, disableMinor: false } }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // Delegates rather than capturing, so a per-test `useQuery` is the one that
  // actually gets called. Wiring the captured reference in directly leaves the
  // mock pointing at whatever existed when the module was first imported.
  trpc: {
    image: {
      getEntitiesCoverImage: {
        useQuery: (...args: unknown[]) => state.useQuery(...args),
      },
    },
  },
}));

import { useNotificationThumbnails } from '~/components/Notifications/notification-thumbnails';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  const root = createRoot(document.createElement('div'));
  function Probe() {
    result.current = useHook();
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return result;
}

const IMAGE_ID = 99;
const OTHER_USER = 555;

const givenImage = (overrides: Record<string, unknown> = {}) => {
  state.images = [
    {
      id: IMAGE_ID,
      entityId: IMAGE_ID,
      entityType: 'Image',
      url: 'abc-123',
      type: 'image',
      nsfwLevel: 1,
      userId: OTHER_USER,
      poi: false,
      minor: false,
      tags: [],
      ...overrides,
    },
  ];
};

const thumbnailsFor = (imageId: number = IMAGE_ID) =>
  renderHook(() => useNotificationThumbnails([{ details: { imageId } }])).current;

beforeEach(() => {
  state.hiddenTags = new Map();
  state.browsingLevel = 1;
  state.images = [];
  state.useQuery = vi.fn(() => ({ data: state.images }));
});

describe('resolving the image a notification is about', () => {
  // The control the three drop cases below are worthless without: they would
  // all pass against a hook that returned an empty map unconditionally.
  it('returns an image the viewer is allowed to see', () => {
    givenImage();

    expect(thumbnailsFor().get(IMAGE_ID)).toMatchObject({ id: IMAGE_ID, url: 'abc-123' });
  });

  it('drops an image above the viewer browsing level', () => {
    givenImage({ nsfwLevel: 2 });

    expect(thumbnailsFor().size).toBe(0);
  });

  // Pins the tags -> tagIds mapping the hook does by hand. Drop that one line
  // and every hidden-tag check silently reads an empty list instead.
  it('drops an image carrying a tag the viewer hid', () => {
    givenImage({ tags: [{ id: 5 }] });
    state.hiddenTags = new Map([[5, true]]);

    expect(thumbnailsFor().size).toBe(0);
  });

  it('asks for the ids as Image entities, in one query', () => {
    givenImage();

    thumbnailsFor();

    expect(state.useQuery).toHaveBeenCalledTimes(1);
    expect(state.useQuery.mock.calls[0][0]).toEqual({
      entities: [{ entityType: 'Image', entityId: IMAGE_ID }],
    });
  });

  it('asks for nothing when no notification names an image', () => {
    givenImage();

    renderHook(() => useNotificationThumbnails([{ details: { placementId: 1 } }]));

    expect(state.useQuery.mock.calls[0][1]).toMatchObject({ enabled: false });
  });
});
