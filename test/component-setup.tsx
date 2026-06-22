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
    useRouter: () => router,
    Router: router,
    default: router,
    withRouter: (Component: React.ComponentType) => Component,
  };
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
