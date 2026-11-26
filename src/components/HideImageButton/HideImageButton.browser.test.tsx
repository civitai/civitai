import { cleanNotifications, Notifications } from '@mantine/notifications';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as HiddenPreferencesHooks from '~/hooks/hidden-preferences';

// A hidden-preferences store small enough to read, wired through the same hook names the
// component imports; the feed filter below is the app's real `filterPreferences('images')`.
const store = vi.hoisted(() => {
  const hidden = new Set<number>();
  const listeners = new Set<() => void>();
  let snapshot: number[] = [];
  const state = { failNext: false };
  // Mirrors the server: `hidden` forces the end state, omitting it flips the current one.
  const apply = (id: number, force?: boolean) => {
    const next = force ?? !hidden.has(id);
    if (next) hidden.add(id);
    else hidden.delete(id);
    snapshot = [...hidden];
    listeners.forEach((l) => l());
  };
  const toggle = (id: number) => apply(id);
  return {
    hidden,
    state,
    apply,
    reset() {
      hidden.clear();
      snapshot = [];
      state.failNext = false;
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
    toggle,
  };
});

vi.mock('~/hooks/hidden-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferencesHooks>()),
  useHiddenPreferencesData: () => {
    const ids = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return { hiddenImages: ids.map((id) => ({ id, hidden: true })) };
  },
  useToggleHiddenPreferences: () => {
    type Vars = { data: Array<{ id: number }>; hidden?: boolean };
    const run = async (vars: Vars) => {
      if (store.state.failNext) {
        store.state.failNext = false;
        throw new Error('network down');
      }
      store.apply(vars.data[0].id, vars.hidden);
    };
    // React Query drops `mutate`'s per-call callbacks once the calling component unmounts.
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);
    const mutate = (vars: Vars, opts?: { onError?: (error: unknown) => void }) => {
      run(vars).catch((error) => {
        if (mounted.current) opts?.onError?.(error);
      });
    };
    return { isPending: false, mutate, mutateAsync: run };
  },
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: any) => children,
}));

import { renderWithProviders } from '../../../test/component-setup';
import { HideImageButton } from '~/components/HideImageButton/HideImageButton';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';

const image = (id: number) => ({
  id,
  userId: 9,
  nsfwLevel: 1,
  tagIds: [] as number[],
  poi: false,
  minor: false,
  prompt: '',
});

function Feed() {
  const hiddenIds = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { items } = filterPreferences({
    type: 'images',
    data: [image(1), image(2)],
    hiddenPreferences: {
      hiddenUsers: new Map(),
      hiddenTags: new Map(),
      hiddenModels: new Map(),
      hiddenModel3Ds: new Map(),
      hiddenImages: new Map(hiddenIds.map((id) => [id, true])),
      hiddenLoading: false,
      moderatedTags: [],
      systemHiddenTags: new Map(),
    } as any,
    browsingLevel: 1,
    currentUser: null as any,
    canViewNsfw: true,
  } as any) as { items: Array<{ id: number }> };
  return (
    <>
      {items.map((i) => (
        <div key={i.id} data-testid="card" data-image-id={i.id}>
          <HideImageButton imageId={i.id} />
        </div>
      ))}
    </>
  );
}

beforeEach(() => {
  store.reset();
  cleanNotifications();
});

const cardCount = () => document.querySelectorAll('[data-testid="card"]').length;

describe('HideImageButton', () => {
  test('hiding an image offers Undo on the toast, and Undo brings the card back in the feed', async () => {
    await renderWithProviders(<Notifications />);
    await renderWithProviders(<Feed />);
    await expect.element(page.getByTestId('card').nth(1)).toBeVisible();

    await userEvent.click(page.getByRole('button', { name: 'Hide' }).first());

    await expect.element(page.getByText('Image hidden')).toBeVisible();
    await expect.poll(cardCount).toBe(1);

    await userEvent.click(page.getByRole('button', { name: 'Undo' }));

    await expect.poll(cardCount).toBe(2);
    expect(document.querySelector('[data-image-id="1"]')).not.toBeNull();
    await expect.poll(() => page.getByText('Image hidden').elements().length).toBe(0);
  });

  test('Undo forces the image visible even if it was already unhidden elsewhere', async () => {
    await renderWithProviders(<Notifications />);
    await renderWithProviders(<Feed />);
    await userEvent.click(page.getByRole('button', { name: 'Hide' }).first());
    await expect.element(page.getByText('Image hidden')).toBeVisible();

    store.apply(1, false);
    await expect.poll(cardCount).toBe(2);

    await userEvent.click(page.getByRole('button', { name: 'Undo' }));

    await expect.poll(() => page.getByText('Image hidden').elements().length).toBe(0);
    expect(cardCount()).toBe(2);
  });

  test('a failed Undo shows an error even after the card has unmounted', async () => {
    await renderWithProviders(<Notifications />);
    const feed = await renderWithProviders(<Feed />);
    await userEvent.click(page.getByRole('button', { name: 'Hide' }).first());
    await expect.element(page.getByText('Image hidden')).toBeVisible();

    await feed.unmount();
    store.state.failNext = true;
    await userEvent.click(page.getByRole('button', { name: 'Undo' }));

    await expect.element(page.getByText('Could not undo')).toBeVisible();
  });

  test('unhiding offers no Undo', async () => {
    store.apply(1, true);
    await renderWithProviders(<Notifications />);
    await renderWithProviders(<HideImageButton imageId={1} />);
    await userEvent.click(page.getByRole('button', { name: 'Unhide' }));
    await expect.element(page.getByText('Image unhidden')).toBeVisible();
    expect(page.getByRole('button', { name: 'Undo' }).elements()).toHaveLength(0);
  });
});
