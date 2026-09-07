import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as CivitaiLinkProviderModule from '~/components/CivitaiLink/CivitaiLinkProvider';
import type * as DialogProviderModule from '~/components/Dialog/DialogProvider';

// Minting on the node-pack path spends one of the user's instance-limit slots, so the
// wizard must not mint until the user asks for a code.

const mocks = vi.hoisted(() => ({
  /** Every pairing-related context call the wizard made, in order. */
  calls: [] as string[],
}));

vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogProviderModule>()),
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));

// Spread, don't replace: the moment anything in the graph imports another of this
// module's exports (the provider, the store, `UNAVAILABLE_ON_DOMAIN`), a bare mock
// fails the file at IMPORT — which collects zero tests and still reports green.
vi.mock('~/components/CivitaiLink/CivitaiLinkProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiLinkProviderModule>()),
  useCivitaiLink: () => link,
}));

vi.mock('~/utils/fetch-link-releases', () => ({
  fetchLinkReleases: async () => ({ os: 'Windows', tag_name: 'v1.21.0', href: 'https://example' }),
}));

import { renderWithProviders } from '../../../../test/component-setup';
import CivitaiLinkWizardModal from '~/components/CivitaiLink/CivitaiLinkWizard';

const record = (name: string) => () => {
  mocks.calls.push(name);
  return Promise.resolve();
};

const link = {
  connected: false,
  instance: undefined,
  instances: [],
  socketConnected: true,
  resources: [],
  error: undefined,
  status: 'no-instances' as const,
  pairingStatus: undefined,
  createInstance: record('createInstance'),
  deleteInstance: record('deleteInstance'),
  renameInstance: record('renameInstance'),
  selectInstance: record('selectInstance'),
  deselectInstance: record('deselectInstance'),
  awaitPairing: record('awaitPairing'),
  cancelAwaitPairing: record('cancelAwaitPairing'),
  runCommand: async () => ({ promise: Promise.resolve(), id: '', cancel: () => undefined }),
};

const advanceTo = async (label: string) => {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: `I've installed it` }).click();
  await expect.element(page.getByText(label)).toBeInTheDocument();
};

describe('CivitaiLinkWizard — pairing mechanism per path', () => {
  beforeEach(() => {
    mocks.calls = [];
  });

  test('the node-pack path waits for a sign-in and mints no code', async () => {
    renderWithProviders(<CivitaiLinkWizardModal />);

    await advanceTo('Sign in from ComfyUI');

    expect(mocks.calls).toEqual(['awaitPairing']);
  });

  test('the code fallback cancels the wait before minting', async () => {
    renderWithProviders(<CivitaiLinkWizardModal />);
    await advanceTo('Sign in from ComfyUI');

    await page.getByRole('button', { name: 'Use a pairing code' }).click();
    await expect.element(page.getByText('Pair with this code')).toBeInTheDocument();

    // Not a count: the step's unmount cleanup cancels too. What must hold is that no
    // cancel lands after the create — i.e. the poll was never armed across it.
    const created = mocks.calls.indexOf('createInstance');
    expect(created).toBeGreaterThan(-1);
    expect(mocks.calls.lastIndexOf('cancelAwaitPairing')).toBeLessThan(created);
  });

  // Without this the suite doesn't discriminate on `path`: a wizard that ignored it
  // entirely would pass both tests above.
  test('the desktop path waits too, and offers no code', async () => {
    renderWithProviders(<CivitaiLinkWizardModal />);

    await page.getByRole('button', { name: /Link desktop app/ }).click();
    await advanceTo('Sign in from the app');

    expect(mocks.calls).toEqual(['awaitPairing']);
    await expect.element(page.getByText('Use a pairing code')).not.toBeInTheDocument();
  });
});
