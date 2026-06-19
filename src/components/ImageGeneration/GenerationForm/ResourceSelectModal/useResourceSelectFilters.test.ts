import { beforeEach, describe, expect, test, vi } from 'vitest';

// SECURITY PROPERTY UNDER TEST — the `publicOnly` visibility clause.
//
// The App Blocks page / model-slot resource pickers open the native
// ResourceSelectModal with `options.publicOnly: true` so an untrusted iframe
// can never enumerate the viewer's OWN private models. The actual enforcement
// lives in the Meili-filter string this builder emits: WITHOUT publicOnly the
// base visibility clause is `(availability != Private OR user.id = <me>)` (the
// in-app generator lets you see your own private library); WITH publicOnly the
// `OR user.id = <me>` disjunct is DROPPED, leaving only `availability != Private`.
//
// The IframeHost / page-picker call-site tests only assert that
// `options.publicOnly === true` is passed — they don't prove the rendered
// filter actually drops the private clause. This test asserts the STRING the
// builder produces, so the leak-prevention clause can't silently rot.

// `useResourceSelectMeiliFilters` is a hook (its body is wrapped in a single
// `useMemo`). It is otherwise a pure function of the values it destructures
// from `useResourceSelectContext()` and `useCurrentUser()`. We mock those two
// source hooks and make React's `useMemo` call its factory through, so the
// builder can be exercised directly in the node-env unit project (no DOM).

const mockUseResourceSelectContext = vi.fn();
const mockUseCurrentUser = vi.fn();

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    // Call-through: outside a React render tree the real useMemo has no fiber,
    // so we evaluate the factory immediately. Deterministic for a pure builder.
    useMemo: (factory: () => unknown) => factory(),
  };
});

vi.mock(
  '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider',
  () => ({ useResourceSelectContext: () => mockUseResourceSelectContext() })
);

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mockUseCurrentUser(),
}));

import { useResourceSelectMeiliFilters } from './useResourceSelectFilters';

const VIEWER_ID = 12345;

// A minimal but realistic context: a Checkpoint slot with no baseModel
// narrowing, the same shape the App Blocks pickers open the modal with.
function baseContext(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    canGenerate: true,
    resources: [{ type: 'Checkpoint', baseModels: [] }],
    selectSource: 'generation',
    filters: { types: [], baseModels: [] },
    publicOnly: false,
    ...overrides,
  };
}

// The builder also needs the data-arg bag; for the `all` tab none of it is read,
// so every data source is left empty. Typed via the hook's own parameter type
// so the test tracks the real signature.
const emptyArgs: Parameters<typeof useResourceSelectMeiliFilters>[0] = {
  selectedTab: 'all',
  featuredModels: undefined,
  // typed non-optional in the hook signature; the `all` tab never reads it.
  generationData: [],
  trainingModels: undefined,
  manuallyAdded: undefined,
  recommendedModels: undefined,
  auctionModels: undefined,
  likedModels: undefined,
};

function buildFilter() {
  return useResourceSelectMeiliFilters(emptyArgs);
}

describe('useResourceSelectMeiliFilters — publicOnly visibility clause', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCurrentUser.mockReturnValue({ id: VIEWER_ID });
  });

  test('WITHOUT publicOnly: a logged-in viewer can see their OWN private models (clause keeps user.id)', () => {
    mockUseResourceSelectContext.mockReturnValue(baseContext({ publicOnly: false }));

    const filter = buildFilter();

    expect(filter).toBeTruthy();
    // The base visibility clause must allow the private-library disjunct.
    expect(filter).toContain('availability != Private');
    // The "see my own private" clause must be present.
    expect(filter).toContain(`user.id = ${VIEWER_ID}`);
    // Sanity: it's the OR form, not the bare public-only clause.
    expect(filter).toContain(
      `(availability != Private OR user.id = ${VIEWER_ID})`
    );
  });

  test('WITH publicOnly: the private-library clause is DROPPED (no user.id leak)', () => {
    mockUseResourceSelectContext.mockReturnValue(baseContext({ publicOnly: true }));

    const filter = buildFilter();

    expect(filter).toBeTruthy();
    // Public visibility is still enforced.
    expect(filter).toContain('availability != Private');
    // SECURITY: the viewer's private library must NOT be reachable — the
    // `OR user.id = <me>` disjunct is removed entirely.
    expect(filter).not.toContain('user.id');
    expect(filter).not.toContain(`user.id = ${VIEWER_ID}`);
  });
});
