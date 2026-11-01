import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellStatus } from '~/components/Shell/shell-bootstrap-context';

/**
 * Wiring test for `FaroProvider`'s session-attributes seam: the `region` prop threaded in
 * from _app and the MERGED attributes map that reaches `initializeFaro`'s
 * `sessionTracking.session.attributes`. That map is the load-bearing surface — the Faro
 * session manager bakes it onto the session at creation, so whatever lands here rides on
 * `meta.session.attributes` of EVERY beacon (→ Loki `session_attr_*`).
 *
 * Node tier (the blocking one — see appsPageLayoutRender.test.ts for why this file is here
 * and not in the browser project): the provider runs init in a `useEffect`, which
 * `renderToStaticMarkup` never fires, so `react`'s `useEffect` is replaced with a
 * synchronous version for this file. Everything else on the init path is real — the
 * experiment-flags builder, the geo-attributes builder, and the defensive merge.
 *
 * Mocked around the component: the Faro SDK (capture `initializeFaro`), the env module, the
 * flags hook, and the two instrumentation modules (their graphs pull all of OTel; they are
 * not what this file tests).
 */

const { initializeFaro, faro, envValues, featuresValue, buildResourceTiming } = vi.hoisted(() => ({
  initializeFaro: vi.fn(),
  faro: { pause: vi.fn(), unpause: vi.fn(), instrumentations: { add: vi.fn() } },
  /** One stand-in instrumentation when the gate passes its cohort, as the real builder would. */
  buildResourceTiming: vi.fn((gate: { cohortEnabled: boolean }) =>
    gate.cohortEnabled ? [{ name: 'resource-timing-stub' }] : []
  ),
  envValues: {
    NEXT_PUBLIC_FARO_ENABLED: 'true',
    NEXT_PUBLIC_FARO_COLLECTOR_URL: 'https://faro.test/collect',
    NEXT_PUBLIC_FARO_SESSION_SAMPLE_RATE: '1.0',
    NEXT_PUBLIC_FARO_TRACES_SAMPLE_RATE: '0.1',
    NEXT_PUBLIC_FARO_RESOURCE_TIMING_ENABLED: 'false',
    NEXT_PUBLIC_FARO_RESOURCE_TIMING_SAMPLE_RATE: '0.05',
    NEXT_PUBLIC_FARO_RESOURCE_TIMING_MAX_PER_WINDOW: '8',
    NEXT_PUBLIC_GIT_HASH: 'abc1234567',
  } as Record<string, string | undefined>,
  featuresValue: { faro: true, faroResourceTiming: false } as Record<string, boolean>,
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Static render never fires effects; run them synchronously so the init path executes.
  useEffect: (fn: () => void) => fn(),
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
  buildResourceTimingInstrumentations: buildResourceTiming,
}));

/** Pin `Intl.DateTimeFormat().resolvedOptions().timeZone` to a deterministic IANA zone. */
const mockTimeZone = (zone: string) => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    () => ({ resolvedOptions: () => ({ timeZone: zone }) } as Intl.DateTimeFormat)
  );
};

const setWindow = (present: boolean) => {
  if (present) {
    (globalThis as unknown as { window: unknown }).window = {
      location: { origin: 'https://civitai.test' },
    };
  } else {
    delete (globalThis as unknown as { window?: unknown }).window;
  }
};

/**
 * Render the provider with a FRESH module generation (`vi.resetModules` + re-import) —
 * `initFaro`'s module guard makes init one-shot per module instance, so each render that
 * should reach `initializeFaro` needs new module state. MUST be awaited: the dynamic import
 * defers the whole render past the current microtask. With `shellStatus` it renders inside
 * `ShellBootstrapProvider` as `_app` does on a shell boot; without, outside it.
 */
const renderProvider = async (
  region: string | null | undefined,
  hardLoad: { shell: boolean; signedIn: boolean } = { shell: false, signedIn: false },
  shellStatus?: ShellStatus
) => {
  vi.resetModules();
  const { render } = await freshModules();
  return render({ region, ...hardLoad }, shellStatus);
};

/**
 * `FaroProvider` and `ShellBootstrapProvider` from ONE fresh module generation (the context
 * instance must be the one the provider reads), and a static render of the first inside the
 * second when given a shell status.
 */
async function freshModules() {
  const { FaroProvider } = await import('~/components/Faro/FaroProvider');
  const { ShellBootstrapProvider } = await import('~/components/Shell/shell-bootstrap-context');
  const render = (
    props: { region: string | null | undefined; shell: boolean; signedIn: boolean },
    shellStatus?: ShellStatus
  ) => {
    const provider = createElement(FaroProvider, props);
    return renderToStaticMarkup(
      shellStatus
        ? createElement(ShellBootstrapProvider, { status: shellStatus }, provider)
        : provider
    );
  };
  return { render };
}

const initOptions = () =>
  initializeFaro.mock.calls[0][0] as {
    sessionTracking: { samplingRate: number; session?: { attributes: Record<string, string> } };
    pageTracking?: { page?: { attributes?: Record<string, string> } };
  };

beforeEach(() => {
  initializeFaro.mockClear();
  faro.instrumentations.add.mockClear();
  buildResourceTiming.mockClear();
  setWindow(true);
});

afterEach(() => {
  setWindow(false);
  vi.restoreAllMocks();
});

describe('FaroProvider — session-attributes wiring', () => {
  it('threads the `region` prop AND the exp_* attributes into ONE session.attributes map', async () => {
    mockTimeZone('America/New_York');
    await renderProvider('US');

    expect(initializeFaro).toHaveBeenCalledTimes(1);
    const attrs = initOptions().sessionTracking.session?.attributes;
    expect(attrs).toMatchObject({
      // experiment side (both cohorts, from buildRumExperimentAttributes)
      exp_gen_tab_defer_view: 'false',
      // geo side (from buildRumGeoAttributes, built from the region prop)
      region: 'US',
      timezone: 'America/New_York',
    });
    // Sampling config is untouched by the merge.
    expect(initOptions().sessionTracking.samplingRate).toBe(1);
  });

  it('maps a null region to `unknown` — the always-set rule holds through the provider', async () => {
    mockTimeZone('America/New_York');
    await renderProvider(null);

    const attrs = initOptions().sessionTracking.session?.attributes;
    expect(attrs?.region).toBe('unknown');
    expect(attrs?.timezone).toBe('America/New_York');
    // Both experiment attributes still present — neither side of the merge was dropped.
    expect(attrs?.exp_gen_tab_defer_view).toBe('false');
  });

  it('still sets the geo attributes when the timezone cannot be resolved (Intl throws)', async () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('Intl unavailable');
    });
    await renderProvider('GB');

    const attrs = initOptions().sessionTracking.session?.attributes;
    expect(attrs?.region).toBe('GB');
    expect(attrs?.timezone).toBe('unknown');
  });

  it('emits nothing when the faro flag is off', async () => {
    featuresValue.faro = false;
    await renderProvider('US');
    expect(initializeFaro).not.toHaveBeenCalled();
    featuresValue.faro = true;
  });

  it('initializes exactly once per module generation (the init guard)', async () => {
    mockTimeZone('America/New_York');
    vi.resetModules();
    const { FaroProvider } = await import('~/components/Faro/FaroProvider');
    // TWO renders against the SAME module instance — StrictMode double-mount and
    // Fast-Refresh re-mounts must not re-initialize (module + window guards).
    const props = { region: 'US', shell: false, signedIn: false };
    renderToStaticMarkup(createElement(FaroProvider, props));
    renderToStaticMarkup(createElement(FaroProvider, props));
    expect(initializeFaro).toHaveBeenCalledTimes(1);
  });
});

describe('FaroProvider — page attributes wiring', () => {
  it('a signed-in shell hard load reaches initializeFaro as `shell` + `signed-in`', async () => {
    await renderProvider('US', { shell: true, signedIn: true });
    expect(initOptions().pageTracking?.page?.attributes).toEqual({
      render_mode: 'shell',
      viewer: 'signed-in',
    });
  });

  it('an anonymous full render reaches initializeFaro as `ssr` + `anon`', async () => {
    await renderProvider('US');
    expect(initOptions().pageTracking?.page?.attributes).toEqual({
      render_mode: 'ssr',
      viewer: 'anon',
    });
  });

  it('they are PAGE attributes, never session ones (a session outlives the hard load)', async () => {
    await renderProvider('US', { shell: true, signedIn: true });
    const sessionAttrs = initOptions().sessionTracking.session?.attributes;
    expect(sessionAttrs).not.toHaveProperty('render_mode');
    expect(sessionAttrs).not.toHaveProperty('viewer');
  });
});

/**
 * The resource_timing cohort is a per-user flag. A static shell boots on user-less flags and
 * gets the viewer's with its page data (`useShellReady`), so on a shell the cohort must be read
 * from those, never from the boot flags — in either direction.
 */
describe('FaroProvider — resource_timing cohort on a shell boot', () => {
  /** The instrumentations `initializeFaro` was handed that are the resource-timing stub. */
  const resourceTimingAtInit = () =>
    (
      initializeFaro.mock.calls[0][0] as { instrumentations: { name?: string }[] }
    ).instrumentations.filter((i) => i.name === 'resource-timing-stub').length;

  afterEach(() => {
    featuresValue.faroResourceTiming = false;
  });

  it('a full render in the cohort: attached at init, and not added a second time', async () => {
    featuresValue.faroResourceTiming = true;
    await renderProvider('US');
    expect(resourceTimingAtInit()).toBe(1);
    expect(faro.instrumentations.add).not.toHaveBeenCalled();
  });

  it('a shell whose boot flags say "in the cohort" does not attach it before the viewer’s arrive', async () => {
    featuresValue.faroResourceTiming = true;
    await renderProvider('US', { shell: true, signedIn: true }, 'pending');
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(resourceTimingAtInit()).toBe(0);
    expect(faro.instrumentations.add).not.toHaveBeenCalled();
  });

  it('a shell viewer in the cohort gets it attached once the viewer’s flags arrive', async () => {
    vi.resetModules();
    const { render } = await freshModules();
    const props = { region: 'US', shell: true, signedIn: true };
    // Boot: user-less flags, not in the cohort.
    render(props, 'pending');
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(resourceTimingAtInit()).toBe(0);
    expect(faro.instrumentations.add).not.toHaveBeenCalled();
    // Page data adopted: the viewer's own flags put them in it.
    featuresValue.faroResourceTiming = true;
    render(props, 'ready');
    render(props, 'ready');
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(faro.instrumentations.add).toHaveBeenCalledTimes(1);
    expect(faro.instrumentations.add).toHaveBeenCalledWith({ name: 'resource-timing-stub' });
  });

  it('a shell viewer outside the cohort never gets it', async () => {
    vi.resetModules();
    const { render } = await freshModules();
    const props = { region: 'US', shell: true, signedIn: true };
    render(props, 'pending');
    render(props, 'ready');
    expect(resourceTimingAtInit()).toBe(0);
    expect(faro.instrumentations.add).not.toHaveBeenCalled();
  });
});
