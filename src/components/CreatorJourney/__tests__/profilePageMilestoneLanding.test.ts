// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const mocks = vi.hoisted(() => ({ landing: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { username: 'JustMaier' } }) }));
vi.mock('~/server/utils/server-side-helpers', () => ({ createServerSideProps: () => undefined }));
vi.mock('~/components/Profile/ProfileLayout2', () => ({ UserProfileLayout: () => null }));
vi.mock('~/components/CreatorJourney/useMilestoneLanding', () => ({
  useMilestoneLanding: mocks.landing,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  // Still loading, so the page stops at its loader; the hook runs before that return.
  trpc: makeTrpcProxy({
    'userProfile.get': { useQuery: () => ({ isLoading: true, data: { id: 7 } }) },
  }),
}));

import type * as Trpc from '~/utils/trpc';
import ProfilePage from '~/pages/user/[username]/index';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('the profile page', () => {
  it('runs the shared-tier-link landing with the profile it loaded', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(React.createElement(MantineProvider, null, React.createElement(ProfilePage)))
    );
    expect(mocks.landing).toHaveBeenCalledWith({ id: 7 });
  });
});
