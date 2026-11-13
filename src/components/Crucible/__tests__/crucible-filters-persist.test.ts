// @vitest-environment happy-dom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /crucibles filters must survive leaving and coming back, like the other feeds. A fresh
 * FiltersProvider re-reads localStorage, which is what a return visit does; the provider and
 * its schema are real, only the URL is stubbed.
 */
const state = vi.hoisted(() => ({ query: {} as Record<string, unknown> }));

vi.mock('~/hooks/useZodRouteParams', () => ({
  useZodRouteParams: () => ({ query: state.query, replace: vi.fn() }),
}));

import {
  defaultCrucibleStatus,
  toCrucibleFilterPatch,
  useCrucibleFilters,
} from '~/components/Crucible/crucible.utils';
import { FiltersProvider, useFiltersContext } from '~/providers/FiltersProvider';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';

type Probe = {
  filters: ReturnType<typeof useCrucibleFilters>;
  setFilters: (patch: Record<string, unknown>) => void;
};

// A mounted page visit: a new provider, so the store is built from localStorage.
function visit() {
  const root = createRoot(document.createElement('div'));
  const ref: { current?: Probe } = {};
  function Probe() {
    ref.current = {
      filters: useCrucibleFilters(),
      setFilters: useFiltersContext((s) => s.setCrucibleFilters),
    };
    return null;
  }
  act(() => root.render(React.createElement(FiltersProvider, null, React.createElement(Probe))));
  return {
    get filters() {
      return ref.current!.filters;
    },
    set: (patch: Record<string, unknown>) => act(() => ref.current!.setFilters(patch)),
    leave: () => act(() => root.unmount()),
  };
}

beforeEach(() => {
  localStorage.clear();
  state.query = {};
});

describe('crucible filters persist across visits', () => {
  it('a chosen status and content type come back on the next visit', () => {
    const first = visit();
    first.set(
      toCrucibleFilterPatch({ status: [CrucibleStatus.Completed], contentType: MediaType.video })
    );
    first.leave();

    const next = visit();
    expect(next.filters).toMatchObject({
      status: [CrucibleStatus.Completed],
      contentType: MediaType.video,
    });
    next.leave();
  });

  it('clearing removes an earlier choice, on this visit and the next', () => {
    const first = visit();
    first.set(
      toCrucibleFilterPatch({ status: [CrucibleStatus.Completed], contentType: MediaType.video })
    );
    first.set(toCrucibleFilterPatch({ status: defaultCrucibleStatus, contentType: undefined }));
    expect(first.filters).not.toHaveProperty('status');
    expect(first.filters).not.toHaveProperty('contentType');
    first.leave();

    const next = visit();
    expect(next.filters).not.toHaveProperty('status');
    expect(next.filters).not.toHaveProperty('contentType');
    next.leave();
  });

  it('a shared link still overrides the saved choice', () => {
    const first = visit();
    first.set(toCrucibleFilterPatch({ status: [CrucibleStatus.Completed] }));
    first.leave();

    state.query = { status: [CrucibleStatus.Active] };
    const next = visit();
    expect(next.filters).toMatchObject({ status: [CrucibleStatus.Active] });
    next.leave();
  });
});
