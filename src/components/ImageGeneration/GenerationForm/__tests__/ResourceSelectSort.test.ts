// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ClickUp 868kv6mzm. The generation resource picker carried its own copy of the
// Newest-sort rule — `!(!features.canViewNsfw && x.label === 'Newest')` — which had
// no moderator bypass, so a moderator on a domain without `canViewNsfw` saw Newest in
// every feed sort menu and not in this one. #4296 extracted the rule into
// `isSortAvailable` and moved only one of the two copies.
//
// This asserts the picker's OPTIONS, not the predicate. `isSortAvailable` has its own
// tests in src/components/Filters/__tests__/sort-availability.test.ts and they stay
// green if this component goes back to its private copy — only rendering the
// component catches that.

const { availabilityMock, selectMenuSpy } = vi.hoisted(() => ({
  availabilityMock: vi.fn(),
  selectMenuSpy: vi.fn(),
}));

vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: availabilityMock,
}));

// Mocked even though the component no longer calls it, so that REVERTING the fix
// fails on an assertion instead of on "useFeatureFlags can only be used inside
// FeatureFlagsCtx". A revert that throws at render proves only that something
// changed; a revert that returns the wrong option list names what broke. Do not
// delete this because it looks unused — it is what makes the control legible.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: availabilityMock().canViewNsfw }),
}));

vi.mock('~/components/ImageGeneration/GenerationForm/ResourceSelectProvider', () => ({
  useResourceSelectContext: () => ({ sort: 'relevance', setSort: vi.fn() }),
}));

// Stubbed to capture the options it is handed. Asserting on rendered menu text would
// mean opening a Mantine dropdown to see the items, which tests the menu rather than
// the rule.
vi.mock('~/components/SelectMenu/SelectMenu', () => ({
  SelectMenuV2: (props: { options?: { label: string; value: string }[] }) => {
    selectMenuSpy(props.options);
    return null;
  },
}));

import { ResourceSelectSort } from '~/components/ImageGeneration/GenerationForm/ResourceSelectFilters';

const labelsFor = (availability: {
  isModerator: boolean;
  canViewNsfw: boolean;
  showNsfw: boolean;
}) => {
  availabilityMock.mockReturnValue(availability);
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(createElement(ResourceSelectSort));
  });
  expect(selectMenuSpy, 'SelectMenuV2 never rendered — the component moved').toHaveBeenCalled();
  return (selectMenuSpy.mock.calls.at(-1)![0] as { label: string }[]).map((o) => o.label);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ResourceSelectSort options', () => {
  it('offers Newest to a moderator on a domain that cannot view NSFW', () => {
    // The finding. Before the shared predicate this returned Relevance + Popularity.
    expect(labelsFor({ isModerator: true, canViewNsfw: false, showNsfw: false })).toEqual([
      'Relevance',
      'Popularity',
      'Newest',
    ]);
  });

  it('still withholds Newest from a non-moderator on that domain', () => {
    // The control. Without it the case above passes against a build that offers every
    // sort to everyone, which is a different bug — the rule not running at all.
    expect(labelsFor({ isModerator: false, canViewNsfw: false, showNsfw: false })).toEqual([
      'Relevance',
      'Popularity',
    ]);
  });

  it('does not withhold Newest from a non-moderator who merely browses SFW', () => {
    // `showNsfw: false` withholds Newest on the IMAGES feed only. This picker is a
    // model picker, so passing `type: 'models'` is load-bearing — passing 'images'
    // would strip Newest here and this is the assertion that would catch it.
    expect(labelsFor({ isModerator: false, canViewNsfw: true, showNsfw: false })).toEqual([
      'Relevance',
      'Popularity',
      'Newest',
    ]);
  });
});
