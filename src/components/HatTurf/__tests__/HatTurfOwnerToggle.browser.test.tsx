import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as Decorations from '~/shared/constants/event-decoration.constants';

const h = vi.hoisted(() => ({
  user: { id: 1 } as { id: number } | null,
  released: 'birthday2026' as string | undefined,
  stock: { available: 3, optedIn: false, ownerOff: false, mode: 'live' } as
    | { available: number; optedIn: boolean; ownerOff: boolean; mode: string }
    | undefined,
  mutate: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'hatTurf.getStock': {
        useQuery: (_input: unknown, opts: { enabled?: boolean }) => ({
          data: opts.enabled === false ? undefined : h.stock,
        }),
      },
      'hatTurf.setOwnerOff': { useMutation: () => ({ isPending: false, mutate: h.mutate }) },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/shared/constants/event-decoration.constants', async (importOriginal) => ({
  ...(await importOriginal<typeof Decorations>()),
  getReleasedEventDecoration: () => (h.released ? { event: h.released } : undefined),
}));

import { cleanup } from 'vitest-browser-react';
import { HatTurfOwnerToggle } from '~/components/HatTurf/HatTurfOwnerToggle';
import { renderWithProviders } from '../../../../test/component-setup';

const toggle = () =>
  document.body.querySelector<HTMLInputElement>('[data-testid="hat-turf-owner-toggle"]');
const render = () => renderWithProviders(<HatTurfOwnerToggle />);
// Renders on the first commit (mocks are synchronous); the shown rows are the positive control.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.user = { id: 1 };
  h.released = 'birthday2026';
  h.stock = { available: 3, optedIn: false, ownerOff: false, mode: 'live' };
  h.mutate.mockReset();
});
afterEach(() => cleanup());

describe("owner's Hat Turf switch in account settings", () => {
  test('on by default, and turning it off keeps turf off my images', async () => {
    await render();
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()!.checked).toBe(true);
    expect(toggle()!.disabled).toBe(false);
    toggle()!.click();
    expect(h.mutate).toHaveBeenCalledWith({ event: 'birthday2026', off: true });
  });

  test('off: shows off, and turning it on lets people play again', async () => {
    h.stock = { available: 3, optedIn: false, ownerOff: true, mode: 'live' };
    await render();
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()!.checked).toBe(false);
    toggle()!.click();
    expect(h.mutate).toHaveBeenCalledWith({ event: 'birthday2026', off: false });
  });

  // A player cannot wall off their own images.
  test('in Hat Turf: disabled, and says to leave first', async () => {
    h.stock = { available: 3, optedIn: true, ownerOff: false, mode: 'live' };
    await render();
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()!.disabled).toBe(true);
    expect(document.body.textContent).toMatch(/Turn off “Take part in Hat Turf” first/);
    const link = [...document.querySelectorAll('a')].find((a) =>
      /Take part/.test(a.textContent ?? '')
    );
    expect(link?.getAttribute('href')).toBe('/user/account/profile#hat-turf');
  });

  test.each([
    ['signed out', () => (h.user = null)],
    ['no event released', () => (h.released = undefined)],
    ['turf off', () => (h.stock = { available: 0, optedIn: false, ownerOff: false, mode: 'off' })],
  ])('hidden when %s', async (_, arrange) => {
    arrange();
    await render();
    await settle();
    expect(toggle()).toBeNull();
  });
});
