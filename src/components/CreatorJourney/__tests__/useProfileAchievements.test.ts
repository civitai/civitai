// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const mocks = vi.hoisted(() => ({ inputs: [] as unknown[] }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ creatorJourney: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorJourney.getProfileAchievements': {
      useQuery: (input: unknown) => {
        mocks.inputs.push(input);
        return { data: undefined, isLoading: true };
      },
    },
  }),
}));

import type * as Trpc from '~/utils/trpc';
import { useProfileAchievements } from '~/components/CreatorJourney/useProfileAchievements';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function Probe({ spotlight }: { spotlight?: string | null }) {
  useProfileAchievements(7, spotlight);
  return null;
}

function inputFor(spotlight?: string | null) {
  mocks.inputs = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(Probe, { spotlight })));
  return mocks.inputs.at(-1);
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

// The server keys a secret card by a shared link's token only when the query carries it; without one,
// the input matches the profile nav's, so the tab reads the nav's cached answer.
describe('useProfileAchievements', () => {
  it('asks with the token a shared link named', () => {
    expect(inputFor('hidden:night-owl')).toEqual({ userId: 7, spotlight: 'hidden:night-owl' });
  });

  it('asks without one otherwise', () => {
    expect(inputFor(null)).toStrictEqual({ userId: 7 });
    expect(inputFor(undefined)).toStrictEqual({ userId: 7 });
  });
});
