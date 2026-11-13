import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The Link dialog's switch and Preferences > Features are two views of ONE saved setting: they
 * must agree after either one changes. The `user.getFeatureFlags` cache is stood in by a small
 * store; `toggleFeature` is the server, which accepts the write.
 */
const { store } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store = {
    flags: { civitaiLink: true, civitaiLinkNav: false } as Record<string, boolean>,
    listeners,
    set(next: Record<string, boolean>) {
      store.flags = next;
      listeners.forEach((l) => l());
    },
  };
  return { store };
});

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () =>
    useSyncExternalStore(
      (cb) => {
        store.listeners.add(cb);
        return () => store.listeners.delete(cb);
      },
      () => store.flags
    ),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'user.toggleFeature': {
        useMutation: (opts: {
          onMutate: (p: { feature: string; value?: boolean }) => Promise<unknown>;
          onSuccess: () => Promise<void>;
        }) => ({
          mutate: async (p: { feature: string; value?: boolean }) => {
            await opts.onMutate(p);
            await opts.onSuccess();
          },
        }),
      },
    },
    {
      useUtils: () => ({
        user: {
          getFeatureFlags: {
            cancel: async () => undefined,
            getData: () => store.flags,
            setData: (
              _: undefined,
              update: (old: Record<string, boolean>) => Record<string, boolean>
            ) => store.set(update(store.flags)),
            invalidate: async () => undefined,
          },
        },
      }),
    }
  ),
}));

import { ToggleableFeatures } from '~/components/Account/SettingsCard';
import { CivitaiLinkNavSwitch } from '~/components/CivitaiLink/CivitaiLinkNavSwitch';
import { toggleableFeatures } from '~/server/services/feature-flags.service';

const linkFeature = toggleableFeatures.filter((f) => f.key === 'civitaiLinkNav');

function renderBoth() {
  renderWithProviders(
    <>
      <CivitaiLinkNavSwitch />
      <ToggleableFeatures data={linkFeature} />
    </>
  );
  const dialog = page.getByRole('switch', { name: 'Show Civitai Link in the navigation bar' });
  const prefs = page.getByRole('switch', { name: /^Civitai Link/ });
  return { dialog, prefs };
}

beforeEach(() => {
  store.flags = { civitaiLink: true, civitaiLinkNav: false };
});

describe('Civitai Link nav setting', () => {
  test('is off by default in both places', async () => {
    const { dialog, prefs } = renderBoth();
    await expect.element(dialog).not.toBeChecked();
    await expect.element(prefs).not.toBeChecked();
  });

  test('turning it on in the Link dialog turns it on in Preferences, and back off from Preferences', async () => {
    const { dialog, prefs } = renderBoth();

    await userEvent.click(dialog);
    await expect.element(prefs).toBeChecked();
    await expect.element(dialog).toBeChecked();

    await userEvent.click(prefs);
    await expect.element(dialog).not.toBeChecked();
    await expect.element(prefs).not.toBeChecked();
  });

  test('a non-member sees neither switch', async () => {
    store.flags = { civitaiLink: false, civitaiLinkNav: false };
    renderWithProviders(
      <>
        <div data-testid="mounted" />
        <CivitaiLinkNavSwitch />
        <ToggleableFeatures data={linkFeature} />
      </>
    );
    // The sentinel proves the tree rendered; members get two switches (see above).
    await expect.element(page.getByTestId('mounted')).toBeInTheDocument();
    expect(page.getByRole('switch').elements()).toHaveLength(0);
  });
});
