import Router from 'next/router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { BrowserRouterProvider } from '~/components/BrowserRouter/BrowserRouterProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { RoutedDialogLink, triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { RoutedDialogProvider } from '~/components/Dialog/RoutedDialogProvider';
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/components/Image/Detail/ImageDetailModal', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ imageId, images }: { imageId: number; images?: { id: number }[] }) =>
      createElement('div', {
        'data-testid': 'detail',
        'data-image-id': String(imageId),
        'data-list': images?.length ?? 0,
      }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/Dialog/routed-dialog/registry', async () => {
  await import('~/components/Dialog/routed-dialog/image-detail.dialog');
  const { routedDialogDictionary } = await import('~/components/Dialog/routed-dialog/utils');
  return { dialogs: routedDialogDictionary.getItems() };
});

const SOURCE_ID = 146911523;
const REMIX_ID = 147008115;

function Harness() {
  return (
    <BrowserRouterProvider>
      <RoutedDialogProvider />
      <DialogProvider />
      <RoutedDialogLink name="imageDetail" state={{ imageId: SOURCE_ID }}>
        remixed from
      </RoutedDialogLink>
    </BrowserRouterProvider>
  );
}

const shown = () =>
  [...document.querySelectorAll('[data-testid="detail"]')].map((el) => ({
    id: el.getAttribute('data-image-id'),
    list: el.getAttribute('data-list'),
  }));

// The browser router's store is module state that outlives a test, so a mounted provider is
// pointed back at the plain page before each one.
async function renderAtPage(asPath: string, query: Record<string, string>) {
  Object.assign(Router, { pathname: '/images/[imageId]', asPath, query });
  history.replaceState({ url: '/images/[imageId]', as: asPath, state: {} }, '', asPath);
  const view = renderWithProviders(<Harness />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  window.dispatchEvent(
    new CustomEvent('locationchange', { detail: [{ url: '/images/[imageId]', as: asPath }] })
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  return view;
}

afterEach(() => useDialogStore.getState().closeAll());

describe('remix card on the image detail', () => {
  test('hard load: the source opens, nothing shows the remix again', async () => {
    await renderAtPage(`/images/${REMIX_ID}`, { imageId: String(REMIX_ID) });
    await page.getByText('remixed from').click();

    await vi.waitFor(() => expect(shown().length).toBeGreaterThan(0));
    expect(location.pathname).toBe(`/images/${SOURCE_ID}`);
    expect(shown().map((s) => s.id)).toEqual(shown().map(() => String(SOURCE_ID)));
  });

  test('opened off a feed: the source opens with its own list, not the feed it was reached through', async () => {
    await renderAtPage(`/images/${REMIX_ID}`, { imageId: String(REMIX_ID) });
    triggerRoutedDialog({
      name: 'imageDetail',
      state: { imageId: REMIX_ID, images: [{ id: REMIX_ID }, { id: 1 }, { id: 2 }] as never },
    });
    await vi.waitFor(() => expect(shown().length).toBeGreaterThan(0));

    await page.getByText('remixed from').click();

    await vi.waitFor(() => expect(location.pathname).toBe(`/images/${SOURCE_ID}`));
    await vi.waitFor(() => expect(shown().length).toBeGreaterThan(0));
    // every dialog on screen names the source, and none carries the old feed's images
    expect(shown().map((s) => s.id)).toEqual(shown().map(() => String(SOURCE_ID)));
    expect(shown().map((s) => s.list)).toEqual(shown().map(() => '0'));
  });
});
