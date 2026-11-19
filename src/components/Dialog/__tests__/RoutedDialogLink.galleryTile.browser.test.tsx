import Router from 'next/router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import {
  BrowserRouterProvider,
  getBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { RoutedDialogLink, triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { RoutedDialogProvider } from '~/components/Dialog/RoutedDialogProvider';
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/components/Image/Detail/ImageDetailModal', async () => {
  const { createElement } = await import('react');
  const { useBrowserRouter } = await import('~/components/BrowserRouter/BrowserRouterProvider');
  function Detail({ imageId, images }: { imageId: number; images?: { id: number }[] }) {
    const { query } = useBrowserRouter();
    return createElement('div', {
      'data-testid': 'detail',
      'data-image-id': String(query.imageId ?? imageId),
      'data-list': images?.length ?? 0,
      'data-sheet': query.active ? 'expanded' : 'collapsed',
      'data-highlight': query.highlight ?? '',
    });
  }
  return { default: Detail };
});
vi.mock('~/hooks/useCurrentUser', async (o) => ({
  ...(await o<object>()),
  useCurrentUser: () => null,
}));
vi.mock('~/components/Dialog/routed-dialog/registry', async () => {
  await import('~/components/Dialog/routed-dialog/image-detail.dialog');
  const { routedDialogDictionary } = await import('~/components/Dialog/routed-dialog/utils');
  return { dialogs: routedDialogDictionary.getItems() };
});

const FIRST_ID = 146911523;
const TILE_ID = 147008115;
const GALLERY = [{ id: TILE_ID }, { id: 7 }, { id: 8 }] as never;

function Harness() {
  return (
    <BrowserRouterProvider>
      <RoutedDialogProvider />
      <DialogProvider />
      <RoutedDialogLink name="imageDetail" state={{ imageId: TILE_ID, images: GALLERY }}>
        gallery tile
      </RoutedDialogLink>
    </BrowserRouterProvider>
  );
}

const layers = () =>
  [...document.querySelectorAll('[data-testid="detail"]')].map((el) => ({
    id: el.getAttribute('data-image-id'),
    list: el.getAttribute('data-list'),
    sheet: el.getAttribute('data-sheet'),
    highlight: el.getAttribute('data-highlight'),
  }));

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function renderAtPage(asPath: string, query: Record<string, string>) {
  Object.assign(Router, { pathname: '/images/[imageId]', asPath, query });
  history.replaceState({ url: '/images/[imageId]', as: asPath, state: {} }, '', asPath);
  const view = renderWithProviders(<Harness />);
  await settle();
  window.dispatchEvent(
    new CustomEvent('locationchange', { detail: [{ url: '/images/[imageId]', as: asPath }] })
  );
  await settle();
  return view;
}

afterEach(() => useDialogStore.getState().closeAll());

describe('gallery tile on an open image detail', () => {
  test('the remix is the top layer, and one close shows the first image again', async () => {
    await renderAtPage(`/images/${FIRST_ID}?active=true`, {
      imageId: String(FIRST_ID),
      active: 'true',
    });
    triggerRoutedDialog({
      name: 'imageDetail',
      state: { imageId: FIRST_ID, images: [{ id: FIRST_ID }, { id: 1 }] as never },
    });
    await vi.waitFor(() => expect(layers().length).toBeGreaterThan(0));

    await page.getByText('gallery tile').click();

    await vi.waitFor(() => expect(location.pathname).toBe(`/images/${TILE_ID}`));
    await vi.waitFor(() => expect(layers().at(-1)?.id).toBe(String(TILE_ID)));

    history.back();
    await vi.waitFor(() => expect(location.pathname).toBe(`/images/${FIRST_ID}`));
    await settle();
    expect(layers().at(-1)?.id).toBe(String(FIRST_ID));
  });

  test('the remix opens with its info sheet collapsed, not carried over from the first image', async () => {
    await renderAtPage(`/images/${FIRST_ID}`, { imageId: String(FIRST_ID) });
    triggerRoutedDialog({ name: 'imageDetail', state: { imageId: FIRST_ID } });
    await vi.waitFor(() => expect(layers().length).toBeGreaterThan(0));
    // What the provider's toggleInfo does to expand the sheet.
    const router = getBrowserRouter();
    router.push({ query: { ...router.query, active: true } }, router.asPath);
    await vi.waitFor(() => expect(layers().at(-1)?.sheet).toBe('expanded'));

    await page.getByText('gallery tile').click();

    await vi.waitFor(() => expect(layers().at(-1)?.id).toBe(String(TILE_ID)));
    expect(layers().at(-1)?.sheet).toBe('collapsed');
  });

  test('an image opened over a comment link does not inherit its highlight', async () => {
    await renderAtPage(`/images/${FIRST_ID}`, { imageId: String(FIRST_ID) });
    // The opener's route as a comment notification links it.
    const router = getBrowserRouter();
    router.replace(
      { query: { ...router.query, highlight: 777 } },
      `${router.asPath}?highlight=777`
    );
    await vi.waitFor(() => expect(getBrowserRouter().query?.highlight).toBe(777));

    await page.getByText('gallery tile').click();

    await vi.waitFor(() => expect(layers().at(-1)?.id).toBe(String(TILE_ID)));
    expect(layers().at(-1)?.highlight).toBe('');
  });
});
