// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  replace: vi.fn(),
  features: {} as Record<string, boolean>,
  shareable: undefined as boolean | undefined,
  shareQueries: [] as { input: unknown; enabled: boolean }[],
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: mocks.query, replace: mocks.replace }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => mocks.features }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorJourney.isMilestoneShareable': {
      useQuery: (input: unknown, { enabled }: { enabled: boolean }) => {
        mocks.shareQueries.push({ input, enabled });
        return { data: enabled ? mocks.shareable : undefined };
      },
    },
  }),
}));

import type * as Trpc from '~/utils/trpc';
import { useMilestoneLanding } from '~/components/CreatorJourney/useMilestoneLanding';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = { id: 7 };
let root: Root | undefined;
let container: HTMLDivElement | undefined;

function Probe({ user }: { user: { id: number } | null }) {
  useMilestoneLanding(user);
  return null;
}

type Visit = {
  query: Record<string, string>;
  user: { id: number } | null;
  shareable: boolean | undefined;
  journeyOn: boolean;
};

// Spread, not destructuring defaults: a default would replace an explicit `shareable: undefined`.
function visit(over: Partial<Visit> = {}) {
  const { query, user, shareable, journeyOn }: Visit = {
    query: { username: 'JustMaier', milestone: 'supernova' },
    user: OWNER,
    shareable: true,
    journeyOn: true,
    ...over,
  };
  mocks.query = query;
  mocks.shareable = shareable;
  mocks.features = journeyOn ? { creatorJourney: true } : {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(Probe, { user })));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  mocks.replace.mockReset();
  mocks.shareQueries = [];
});

describe('a shared tier link opened on the profile', () => {
  it('moves on to the Achievements tab with the tier, once', () => {
    visit();
    expect(mocks.replace.mock.calls).toEqual([
      ['/user/JustMaier/achievements?milestone=supernova'],
    ]);
    // The layout's key and `enabled`: the server render prefetched exactly this.
    expect(mocks.shareQueries.at(-1)).toEqual({
      input: { userId: OWNER.id, milestone: 'supernova' },
      enabled: true,
    });
  });

  it('moves on with a shared achievement, asking about that achievement', () => {
    visit({ query: { username: 'JustMaier', milestone: 'reach:downloads-10000' } });
    expect(mocks.replace.mock.calls).toEqual([
      ['/user/JustMaier/achievements?milestone=reach:downloads-10000'],
    ]);
    expect(mocks.shareQueries.at(-1)).toEqual({
      input: { userId: OWNER.id, milestone: 'reach:downloads-10000' },
      enabled: true,
    });
  });

  it.each([
    ['the tier is not shareable', { shareable: false }],
    ['Creator Journey is off for the visitor', { journeyOn: false }],
    ['the profile has not loaded', { user: null }],
    ['the link names no tier', { query: { username: 'JustMaier' } }],
    [
      'the link names something that is not a tier',
      { query: { username: 'x', milestone: 'nope' } },
    ],
  ])('stays on the profile when %s', (_, over) => {
    visit(over);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  // The server render normally answers at once; when it did not, the redirect waits for the answer.
  it('moves on once the answer arrives, and only once', () => {
    visit({ shareable: undefined });
    expect(mocks.replace).not.toHaveBeenCalled();
    mocks.shareable = true;
    act(() => root?.render(React.createElement(Probe, { user: OWNER })));
    act(() => root?.render(React.createElement(Probe, { user: OWNER })));
    expect(mocks.replace.mock.calls).toEqual([
      ['/user/JustMaier/achievements?milestone=supernova'],
    ]);
  });

  it('does not ask the server before the profile has loaded or without a tier', () => {
    visit({ user: null });
    visit({ query: { username: 'JustMaier' } });
    expect(mocks.shareQueries.length).toBeGreaterThan(0);
    expect(mocks.shareQueries.every((query) => !query.enabled)).toBe(true);
  });
});
