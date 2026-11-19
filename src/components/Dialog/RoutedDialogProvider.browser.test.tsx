import { useRouter } from 'next/router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import { RoutedDialogProvider } from '~/components/Dialog/RoutedDialogProvider';
import { historyLayersSettled, openHistoryLayer, resetHistoryLayers } from '~/utils/history-layers';

vi.mock('~/components/BrowserRouter/BrowserRouterProvider', () => ({
  useBrowserRouter: () => ({ query: {}, push: vi.fn() }),
  getBrowserRouter: vi.fn(),
  setUsingNextRouter: vi.fn(),
}));
vi.mock('~/components/Dialog/routed-dialog/registry', () => ({ dialogs: {} }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// The scaffold's shared router mock (test/component-setup.tsx). Next hands every pop to the one
// callback registered through beforePopState; this reads the one the provider registered.
// eslint-disable-next-line react-hooks/rules-of-hooks -- the scaffold's mock calls no React hook
const router = useRouter();
const registered = () => {
  const calls = vi.mocked(router.beforePopState).mock.calls;
  return calls[calls.length - 1]?.[0];
};
const here = location.pathname + location.search;
const pop = { url: here, as: here, options: {}, __N: true as const, key: 'k' };

afterEach(async () => {
  await historyLayersSettled();
  resetHistoryLayers();
});

describe("RoutedDialogProvider's beforePopState", () => {
  test('a pop that closes a layer keeps Next from re-rendering the page', async () => {
    renderWithProviders(<RoutedDialogProvider />);
    await vi.waitFor(() => expect(registered()).toBeDefined());
    openHistoryLayer(vi.fn());

    // Back from the layer onto the page's own entry, same URL.
    expect(registered()?.(pop)).toBe(false);
  });

  test("with no layer open, the same pop is Next's to handle", async () => {
    renderWithProviders(<RoutedDialogProvider />);
    await vi.waitFor(() => expect(registered()).toBeDefined());

    expect(registered()?.(pop)).toBe(true);
  });
});
