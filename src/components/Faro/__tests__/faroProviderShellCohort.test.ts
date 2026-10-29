// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `FaroProvider`'s late resource_timing attach, under REAL React effects. Its sibling
 * `faroProviderSession.test.ts` replaces `useEffect` with a synchronous call, which runs every
 * effect on every render and so cannot see an effect's dependency array — and the dependency
 * array is the fix: the attach has to re-run when `viewerFlagsReady` turns true, which happens on
 * a RE-render of an already-mounted provider. This mounts it with `react-dom/client`, then
 * re-renders it, exactly as `_app` does when a shell's page data is adopted.
 *
 * Mocked around the component, as in the sibling: the Faro SDK, the env module, the flags hook and
 * the two instrumentation modules.
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

/** A fresh module generation (init is one-shot per module) and a mounted root. */
async function mountProvider() {
  vi.resetModules();
  const { FaroProvider } = await import('~/components/Faro/FaroProvider');
  root = createRoot(container as HTMLElement);
  return (viewerFlagsReady: boolean) =>
    act(() => {
      root?.render(
        createElement(FaroProvider, {
          region: 'US',
          shell: true,
          signedIn: true,
          viewerFlagsReady,
        })
      );
    });
}

describe('FaroProvider — a shell boot’s resource_timing attach, with real effects', () => {
  it('attaches exactly once when the viewer’s flags arrive on a re-render', async () => {
    const render = await mountProvider();

    // Boot: the flags are not the viewer's yet, so the cohort is undecided.
    render(false);
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(resourceTimingAtInit()).toBe(0);
    expect(faro.instrumentations.add).not.toHaveBeenCalled();

    // Page data adopted: the same mounted provider re-renders with the viewer's flags.
    render(true);
    expect(faro.instrumentations.add).toHaveBeenCalledTimes(1);
    expect(faro.instrumentations.add).toHaveBeenCalledWith(RESOURCE_TIMING);

    // Later renders (client navigation) neither re-init nor add it again.
    render(true);
    render(true);
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(faro.instrumentations.add).toHaveBeenCalledTimes(1);
  });

  it('control: flags that are the viewer’s from the start attach it at init, not late', async () => {
    const render = await mountProvider();
    render(true);
    expect(resourceTimingAtInit()).toBe(1);
    render(true);
    expect(faro.instrumentations.add).not.toHaveBeenCalled();
  });
});
