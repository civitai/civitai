/**
 * Component-test scaffold (Vitest browser mode).
 *
 * Loaded as the `component` project's setupFile (vitest.config.mts) AND imported
 * by `*.browser.test.tsx` files for `renderWithProviders`. Side effects on load:
 *  - mock `next/router` (pages-router components call `useRouter()` at render)
 *  - auto-`cleanup()` the rendered tree after every test
 *
 * `renderWithProviders` wraps the unit-under-test in the providers a generation
 * leaf needs: a fresh React-Query client (`retry: false`) + MantineProvider.
 * tRPC hooks are mocked per-test with `vi.mock('~/utils/trpc')` as we climb to
 * data-driven inputs — this scaffold stays network-free.
 */
import React from 'react';
import { afterEach, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// `vi.waitFor` defaults to a 1000ms timeout. That's fine for a DOM mount, but
// the browser suite has ~80 waitFor sites and many await an async round-trip
// (postMessage → consent dialog, a tRPC query settling, a zustand store update).
// On the saturated preview CI box (browser tests share the host with the image
// build) a genuinely-correct round-trip can exceed 1000ms, so the waitFor times
// out and the test PASS→FAILs on load, not on code. Raise the DEFAULT timeout
// globally (calls that pass their own timeout are untouched) — one root-cause fix
// for the whole 1000ms-vs-contention class instead of editing every call site.
{
  const DEFAULT_WAITFOR_TIMEOUT_MS = 10000;
  const original = vi.waitFor.bind(vi);
  vi.waitFor = ((callback: Parameters<typeof original>[0], options?: number | object) => {
    const opts = typeof options === 'number' ? { timeout: options } : { ...(options ?? {}) };
    if ((opts as { timeout?: number }).timeout == null) {
      (opts as { timeout?: number }).timeout = DEFAULT_WAITFOR_TIMEOUT_MS;
    }
    return original(callback, opts);
  }) as typeof vi.waitFor;
}

// Stub the Next pages-router. Returns vi.fn()s so tests can assert navigation
// without a real router; extend per-test via `vi.mocked(useRouter)` if needed.
vi.mock('next/router', () => {
  const router = {
    push: vi.fn().mockResolvedValue(true),
    replace: vi.fn().mockResolvedValue(true),
    prefetch: vi.fn().mockResolvedValue(undefined),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    beforePopState: vi.fn(),
    query: {},
    pathname: '/',
    asPath: '/',
    route: '/',
    basePath: '',
    isReady: true,
    isFallback: false,
    isPreview: false,
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  };
  return {
    // Real `next/router` is an ES module; flag the mock so a DEFAULT import
    // (`import Router from 'next/router'`, used by `useCatchNavigation` and many
    // other components) resolves to the singleton rather than the namespace
    // object under esModuleInterop (whose `.events` would be undefined).
    __esModule: true,
    useRouter: () => router,
    Router: router,
    default: router,
    withRouter: (Component: React.ComponentType) => Component,
  };
});

// Mantine's `useClipboard` (and any copy affordance) calls
// `navigator.clipboard.writeText`. In CI's headless Chromium the page is an
// insecure context with no clipboard permission, so the REAL `writeText`
// rejects — `copied` never flips and the "Copied" affordance never renders.
// That made copy tests pass locally (Chromium grants the permission) but fail
// in CI. Stub a resolving clipboard so copy behaviour is deterministic and
// matches a real secure-context browser. Tests assert the "Copied" UI state,
// not the OS clipboard contents.
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  },
});

afterEach(() => {
  cleanup();
});

function Providers({ children }: { children: React.ReactNode }) {
  // Fresh client per render so cache never leaks between tests.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>{children}</MantineProvider>
    </QueryClientProvider>
  );
}

/**
 * Render a component under the standard generation-form provider stack.
 *
 * Providers are supplied via the `wrapper` option (not by manually wrapping
 * `ui`) so the `rerender` returned by vitest-browser-react re-applies the SAME
 * wrapper on every re-render. Manually wrapping (`render(<Providers>{ui}</…>)`)
 * works for the initial render but `rerender(newUi)` replaces the root with the
 * bare element — dropping MantineProvider/QueryClient and crashing any Mantine
 * child with "MantineProvider was not found". Passing `wrapper` fixes that for
 * every component test that drives prop changes via `rerender`.
 */
export function renderWithProviders(ui: React.ReactElement) {
  return render(ui, { wrapper: Providers });
}
