// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UseExperimentModule from '../useExperiment';
import type * as IntersectionModule from 'react-intersection-observer';

const state = vi.hoisted(() => ({
  user: { id: 501 } as { id: number } | null,
  inView: false,
  experiment: { ready: true, variant: 'badge-popover', assignment: 'rule' } as {
    ready: boolean;
    variant?: string;
    assignment?: string;
  },
  sent: [] as unknown[],
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({
    trackAction: (data: unknown) => {
      state.sent.push(data);
      return Promise.resolve();
    },
  }),
}));
vi.mock('react-intersection-observer', async (importOriginal) => ({
  ...(await importOriginal<typeof IntersectionModule>()),
  useInView: () => ({ ref: () => undefined, inView: state.inView }),
}));
vi.mock('../useExperiment', async (importOriginal) => ({
  ...(await importOriginal<typeof UseExperimentModule>()),
  useExperiment: () => state.experiment,
}));

import { resetExperimentExposuresForTests, useExperimentExposure } from '../useExperimentExposure';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const root = createRoot(document.createElement('div'));
  const Probe = () => {
    useExperimentExposure('hatTurfFeedCard', 'feed-card');
    return null;
  };
  const render = () => act(() => root.render(createElement(Probe)));
  render();
  return { rerender: render };
}

describe('useExperimentExposure', () => {
  beforeEach(() => {
    resetExperimentExposuresForTests();
    localStorage.clear();
    state.user = { id: 501 };
    state.inView = false;
    state.experiment = { ready: true, variant: 'badge-popover', assignment: 'rule' };
    state.sent = [];
  });

  it('logs nothing until the experimental UI is on screen, then the arm and how it was assigned', () => {
    const { rerender } = mount();
    expect(state.sent).toEqual([]);
    state.inView = true;
    rerender();
    expect(state.sent).toEqual([
      {
        type: 'Experiment_Exposure',
        details: {
          exp: 'hatTurfFeedCard',
          variant: 'badge-popover',
          assignment: 'rule',
          surface: 'feed-card',
        },
      },
    ]);
  });

  it('logs once per user, experiment and UTC day, across mounts and tabs', () => {
    state.inView = true;
    mount();
    mount();
    resetExperimentExposuresForTests(); // a second tab: only storage is shared
    mount();
    expect(state.sent).toHaveLength(1);
  });

  it('logs again on a new UTC day', () => {
    state.inView = true;
    localStorage.setItem(
      'experiment-exposures',
      JSON.stringify({ day: '2000-01-01', seen: ['501:hatTurfFeedCard'] })
    );
    mount();
    expect(state.sent).toHaveLength(1);
  });

  it('still logs, once per tab, when storage throws', () => {
    state.inView = true;
    const denied = vi.fn(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied });
    try {
      mount();
      mount();
      expect(denied).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(state.sent).toHaveLength(1);
  });

  it.each([
    [
      'a signed-out assignment',
      { ready: true, variant: 'control', assignment: 'signed-out' },
      true,
    ],
    ['no session user', { ready: true, variant: 'control', assignment: 'rule' }, false],
    ['an assignment still loading', { ready: false }, true],
  ])('logs nothing for %s', (_label, experiment, signedIn) => {
    state.inView = true;
    state.experiment = experiment;
    if (!signedIn) state.user = null;
    mount();
    expect(state.sent).toEqual([]);
  });
});
