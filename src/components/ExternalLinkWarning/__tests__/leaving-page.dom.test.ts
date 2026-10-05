// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The static-markup test beside this one runs no effects and drops `next/head`, so a countdown,
// a `router.replace` or a `<Head>` meta refresh would all pass it. This mounts the page for real.

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/router', () => ({ __esModule: true, useRouter: () => router, default: router }));
// `next/head` renders nothing outside Next's head manager; inline it so a refresh is visible.
vi.mock('next/head', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

const { default: LeavingCivitaiPage } = await import('~/pages/leaving');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('/leaving, mounted', () => {
  it('does not navigate anywhere on its own, however long it is left open', async () => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const before = window.location.href;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          MantineProvider,
          null,
          createElement(LeavingCivitaiPage, { destination: 'https://t.me/SomeGroup' })
        )
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    // Positive control on the mount itself: an empty tree would pass every check below.
    expect(container.querySelector('a[href="https://t.me/SomeGroup"]')?.textContent).toContain(
      'Continue'
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(document.querySelector('meta[http-equiv="refresh" i]')).toBeNull();

    act(() => root.unmount());
  });
});
