// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '~/__tests__/mocks/db.mock';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  listProps: [] as Record<string, unknown>[],
}));
vi.mock('next/router', () => ({ useRouter: () => ({ query: mocks.query }) }));
vi.mock('~/server/utils/server-side-helpers', () => ({ createServerSideProps: () => undefined }));
vi.mock('~/components/Profile/ProfileLayout2', () => ({ UserProfileLayout: () => null }));
vi.mock('~/components/CreatorJourney/useProfileAchievements', () => ({
  useProfileAchievements: () => ({
    data: { tiers: [], achievements: [] },
    count: 1,
    isLoading: false,
  }),
}));
vi.mock('~/components/CreatorJourney/ProfileAchievements', () => ({
  ProfileAchievementsList: (props: Record<string, unknown>) => {
    mocks.listProps.push(props);
    return null;
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'userProfile.get': { useQuery: () => ({ data: { id: 7 } }) },
  }),
}));

import type * as Trpc from '~/utils/trpc';
import AchievementsPage from '~/pages/user/[username]/achievements';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function open(query: Record<string, string>) {
  act(() => root?.unmount());
  container?.remove();
  mocks.listProps = [];
  mocks.query = query;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(React.createElement(MantineProvider, null, React.createElement(AchievementsPage)))
  );
  return mocks.listProps.at(-1);
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  mocks.listProps = [];
});

// A shared tier link arrives here as `?milestone=<tier>`; the list is what rings that card.
describe('the Achievements tab opened from a shared tier link', () => {
  it('hands the list the tier the link named', () => {
    expect(open({ username: 'JustMaier', milestone: 'supernova' })).toMatchObject({
      userId: 7,
      spotlight: 'supernova',
    });
  });

  it('picks out nothing without a tier, or for something that is not one', () => {
    expect(open({ username: 'JustMaier' })?.spotlight).toBeNull();
    expect(open({ username: 'JustMaier', milestone: 'nope' })?.spotlight).toBeNull();
  });
});
