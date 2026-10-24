// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as TrpcModule from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

type MutationOpts = {
  onSuccess: (result: unknown, variables: { kind: string }) => Promise<void>;
};

const h = vi.hoisted(() => ({
  opts: undefined as MutationOpts | undefined,
  invalidateFollowsMe: vi.fn(async () => undefined),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      hiddenPreferences: { getHidden: { setData: vi.fn(), getData: vi.fn(), cancel: vi.fn() } },
      user: {
        getLists: { invalidate: vi.fn(async () => undefined) },
        getList: { invalidate: vi.fn(async () => undefined) },
        getFollowsMe: { invalidate: h.invalidateFollowsMe },
      },
    }),
    hiddenPreferences: {
      toggleHidden: {
        useMutation: (opts: MutationOpts) => {
          h.opts = opts;
          return {};
        },
      },
    },
  },
}));

import { useToggleHiddenPreferences } from '~/hooks/hidden-preferences/useToggleHiddenPreferences';

function mount() {
  function Probe() {
    useToggleHiddenPreferences();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(React.createElement(Probe)));
  act(() => root.unmount());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.invalidateFollowsMe.mockClear();
  mount();
});

describe('toggling a block', () => {
  // `getFollowsMe` never goes stale on its own, so without this a profile keeps reading
  // "Follow back" beside the block notice until a reload.
  it('refreshes the Follow back answer', async () => {
    await h.opts!.onSuccess({}, { kind: 'blockedUser' });
    expect(h.invalidateFollowsMe).toHaveBeenCalledTimes(1);
  });

  it('leaves it alone for a hide, which does not change it', async () => {
    await h.opts!.onSuccess({}, { kind: 'user' });
    expect(h.invalidateFollowsMe).not.toHaveBeenCalled();
  });
});
