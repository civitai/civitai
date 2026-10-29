// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellStatus } from '~/components/Shell/shell-bootstrap-context';

/**
 * Real React effects, not the sibling suite's synchronous `useEffect` stub: that stub runs every
 * effect on every render, so it cannot see the attach effect's dependency array, which must re-run
 * it when the mounted provider re-renders with the shell status turned `ready`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { initializeFaro, faro, envValues, featuresValue } = vi.hoisted(() => ({
  initializeFaro: vi.fn(),
  faro: { pause: vi.fn(), unpause: vi.fn(), instrumentations: { add: vi.fn() } },
  envValues: {
    NEXT_PUBLIC_FARO_ENABLED: 'true',
    NEXT_PUBLIC_FARO_COLLECTOR_URL: 'https://faro.test/collect',
    NEXT_PUBLIC_FARO_SESSION_SAMPLE_RATE: '1.0',
    NEXT_PUBLIC_FARO_TRACES_SAMPLE_RATE: '0.1',
    NEXT_PUBLIC_FARO_RESOURCE_TIMING_ENABLED: 'true',
    NEXT_PUBLIC_GIT_HASH: 'abc1234567',
  } as Record<string, string | undefined>,
  // A viewer IN the cohort by their own flags.
  featuresValue: { faro: true, faroResourceTiming: true } as Record<string, boolean>,
}));

vi.mock('@grafana/faro-web-sdk', () => ({
  initializeFaro,
  faro,
  ErrorsInstrumentation: class {},
  NavigationInstrumentation: class {},
  SessionInstrumentation: class {},
  ViewInstrumentation: class {},
  WebVitalsInstrumentation: class {},
  TransportItemType: { EXCEPTION: 'exception' },
}));
vi.mock('~/env/client', () => ({ env: envValues }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => featuresValue,
}));
vi.mock('~/utils/faro/traceSampler', () => ({
  resolveFaroSampling: () => ({ sessionSamplingRate: 1, traceSampler: {} }),
}));
vi.mock('~/components/Faro/SampledTracingInstrumentation', () => ({
  SampledTracingInstrumentation: class {},
}));
vi.mock('~/components/Faro/ResourceTimingInstrumentation', () => ({
  buildResourceTimingInstrumentations: (gate: { cohortEnabled: boolean }) =>
    gate.cohortEnabled ? [{ name: 'resource-timing-stub' }] : [],
}));

const RESOURCE_TIMING = { name: 'resource-timing-stub' };

/** How many resource-timing instrumentations `initializeFaro` was handed. */
const resourceTimingAtInit = () =>
  (
    initializeFaro.mock.calls[0]?.[0] as { instrumentations: { name?: string }[] } | undefined
  )?.instrumentations.filter((i) => i.name === RESOURCE_TIMING.name).length ?? 0;

let root: Root | undefined;
let container: HTMLElement | undefined;

beforeEach(() => {
  initializeFaro.mockClear();
  faro.instrumentations.add.mockClear();
  delete (window as unknown as Record<string, unknown>).__civitaiFaroInitialized__;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

/**
 * A fresh module generation (init is one-shot per module) and a mounted root. Each render puts the
 * provider inside `ShellBootstrapProvider` with the given status, as `_app` does on a shell boot,
 * or with none outside it, as on every other render.
 */
async function mountProvider() {
  vi.resetModules();
  const { FaroProvider } = await import('~/components/Faro/FaroProvider');
  const { ShellBootstrapProvider } = await import('~/components/Shell/shell-bootstrap-context');
  root = createRoot(container as HTMLElement);
  return (shellStatus?: ShellStatus) =>
    act(() => {
      const provider = createElement(FaroProvider, {
        region: 'US',
        shell: !!shellStatus,
        signedIn: true,
      });
      root?.render(
        shellStatus
          ? createElement(ShellBootstrapProvider, { status: shellStatus }, provider)
          : provider
      );
    });
}

describe('FaroProvider — a shell boot’s resource_timing attach, with real effects', () => {
  it('attaches exactly once when the viewer’s flags arrive on a re-render', async () => {
    const render = await mountProvider();

    // Boot: the flags are not the viewer's yet, so the cohort is undecided.
    render('pending');
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(resourceTimingAtInit()).toBe(0);
    expect(faro.instrumentations.add).not.toHaveBeenCalled();

    // Page data adopted: the same mounted provider re-renders with the viewer's flags.
    render('ready');
    expect(faro.instrumentations.add).toHaveBeenCalledTimes(1);
    expect(faro.instrumentations.add).toHaveBeenCalledWith(RESOURCE_TIMING);

    // Later renders (client navigation) neither re-init nor add it again.
    render('ready');
    render('ready');
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(faro.instrumentations.add).toHaveBeenCalledTimes(1);
  });

  it('a shell whose page data failed never gets it', async () => {
    const render = await mountProvider();
    render('pending');
    render('failed');
    render('failed');
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(resourceTimingAtInit()).toBe(0);
    expect(faro.instrumentations.add).not.toHaveBeenCalled();
  });

  it.each([
    ['not a shell boot', undefined, 1],
    ['a shell whose page data was adopted', 'ready', 1],
    ['a shell still waiting for its page data', 'pending', 0],
    ['a shell whose page data failed', 'failed', 0],
  ] as const)(
    'mounted as %s (status %s): %i resource_timing at init',
    async (_, shellStatus, atInit) => {
      const render = await mountProvider();
      render(shellStatus);
      render(shellStatus);
      expect(initializeFaro).toHaveBeenCalledTimes(1);
      expect(resourceTimingAtInit()).toBe(atInit);
      expect(faro.instrumentations.add).not.toHaveBeenCalled();
    }
  );
});
