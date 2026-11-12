import { Notifications } from '@mantine/notifications';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as HiddenPreferencesHooks from '~/hooks/hidden-preferences';

// A hidden-preferences store small enough to read, wired through the same hook names the
// component imports; the feed filter below is the app's real `filterPreferences('images')`.
const store = vi.hoisted(() => {
  const hidden = new Set<number>();
  const listeners = new Set<() => void>();
  let snapshot: number[] = [];
  const toggle = (id: number) => {
    if (!hidden.delete(id)) hidden.add(id);
    snapshot = [...hidden];
    listeners.forEach((l) => l());
  };
  return {
    hidden,
    reset() {
      hidden.clear();
      snapshot = [];
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
    const run = (vars: { data: Array<{ id: number }> }) => store.toggle(vars.data[0].id);
    return {
      isPending: false,
      mutate: run,
      mutateAsync: async (vars: { data: Array<{ id: number }> }) => run(vars),
    };
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
      <Notifications />
      {items.map((i) => (
        <div key={i.id} data-testid="card" data-image-id={i.id}>
          <HideImageButton imageId={i.id} />
        </div>
      ))}
    </>
  );
}

beforeEach(() => store.reset());

describe('HideImageButton', () => {
  test('hiding an image offers Undo on the toast, and Undo brings the card back in the feed', async () => {
    renderWithProviders(<Feed />);
    await expect.element(page.getByTestId('card').nth(1)).toBeVisible();

    await userEvent.click(page.getByRole('button', { name: 'Hide' }).first());

    await expect.element(page.getByText('Image hidden')).toBeVisible();
    await expect.poll(() => document.querySelectorAll('[data-testid="card"]').length).toBe(1);

    await userEvent.click(page.getByRole('button', { name: 'Undo' }));

    await expect.poll(() => document.querySelectorAll('[data-testid="card"]').length).toBe(2);
    expect(document.querySelector('[data-image-id="1"]')).not.toBeNull();
  });

  test('unhiding offers no Undo', async () => {
    store.toggle(1);
    renderWithProviders(
      <>
        <Notifications />
        <HideImageButton imageId={1} />
      </>
    );
    await userEvent.click(page.getByRole('button', { name: 'Unhide' }));
    await expect.element(page.getByText('Image unhidden')).toBeVisible();
    expect(page.getByRole('button', { name: 'Undo' }).elements()).toHaveLength(0);
  });
});
