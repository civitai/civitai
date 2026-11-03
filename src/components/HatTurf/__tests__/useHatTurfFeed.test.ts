// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
} from '~/shared/constants/birthday2026.constants';
import type * as TrpcModule from '~/utils/trpc';
import type * as UseExperimentModule from '~/components/Experiments/useExperiment';

/**
 * The feed card is flag-gated here and nowhere else: with the flag off the hook must return null
 * and must not ask the server about the event at all. The real hook runs in this test; the
 * provider and card tests mock or inject it.
 */

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let flag = false;
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ hatTurfFeedCard: flag }),
}));

let armReady = true;
vi.mock('~/components/Experiments/useExperiment', async (importOriginal) => ({
  ...(await importOriginal<typeof UseExperimentModule>()),
  useExperiment: () =>
    armReady
      ? { ready: true, variant: 'control', assignment: 'rule' }
      : { ready: false, variant: undefined, assignment: undefined },
}));

let askedWith: { enabled?: unknown } | undefined;
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'event.getAccess': {
        useQuery: (_input: unknown, opts?: { enabled?: unknown }) => {
          askedWith = opts;
          return { data: opts?.enabled ? 'open' : undefined };
        },
      },
    }),
  };
});

const { useHatTurfFeed } = await import('~/components/HatTurf/useHatTurfFeed');

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 60 * 60 * 1000));
  askedWith = undefined;
  armReady = true;
});

function feed() {
  let result: ReturnType<typeof useHatTurfFeed>;
  function Probe() {
    result = useHatTurfFeed();
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(React.createElement(Probe)));
  return result!;
}

describe('useHatTurfFeed', () => {
  it('returns null and asks the server nothing with the flag off, even during an open event', () => {
    flag = false;
    expect(feed()).toBeNull();
    expect(askedWith?.enabled).toBe(false);
  });

  it('returns the event with the flag on and the event open', () => {
    flag = true;
    expect(feed()).toEqual({ event: BIRTHDAY_2026_EVENT });
    expect(askedWith?.enabled).toBe(true);
  });

  it('returns null with the flag on and the event open until the viewer arm is known', () => {
    flag = true;
    armReady = false;
    expect(feed()).toBeNull();
  });
});
