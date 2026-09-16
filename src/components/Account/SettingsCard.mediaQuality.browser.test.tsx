import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useRouter } from 'next/router';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The media-quality select is the only place the lossless membership gate is expressed in UI.
 * Four things it has to get right are invisible to the resolver's unit tests: a non-member's
 * stored `metadata` must read as Compressed (what they are actually served), picking Lossless
 * without a membership must route to pricing and write NOTHING, a paid member's pick must
 * write, and a rejected write must not leave the select showing a preference that never landed.
 */

const { mutate, refresh, currentUser, capturedMutationOptions, showErrorNotification } = vi.hoisted(
  () => ({
    mutate: vi.fn(),
    refresh: vi.fn(async () => null),
    currentUser: {
      value: { id: 7, isPaidMember: false, filePreferences: {} as Record<string, unknown> },
    },
    capturedMutationOptions: { value: undefined as undefined | Record<string, () => void> },
    showErrorNotification: vi.fn(),
  })
);

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ ...currentUser.value, refresh }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ assistantPersonality: false, stickerPlacement: false }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ autoplayGifs: true, setState: vi.fn() }),
}));
vi.mock('~/hooks/useModelFileOptions', () => ({
  useModelFileOptions: () => ({ precisions: ['fp16'], quantTypes: ['Q4_K_M'] }),
}));
vi.mock('~/utils/notifications', () => ({
  showErrorNotification,
  showSuccessNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({ model: { getAll: { invalidate: vi.fn() } } }),
    user: {
      update: {
        useMutation: (options?: Record<string, () => void>) => {
          capturedMutationOptions.value = options;
          return { mutate, isPending: false };
        },
      },
    },
  },
}));

import { ImageFormatSelect } from '~/components/Account/SettingsCard';

const LABEL = 'Media quality';

const openOptions = () => userEvent.click(page.getByRole('textbox', { name: LABEL }));

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.value = { id: 7, isPaidMember: false, filePreferences: {} };
  capturedMutationOptions.value = undefined;
});

describe('ImageFormatSelect — the lossless membership gate', () => {
  test("reads a non-member's stored lossless choice as Compressed", async () => {
    // The choice is deliberately left in the database so it comes back on subscribing. Showing
    // it back as Lossless would claim a delivery they are not getting.
    currentUser.value = {
      id: 7,
      isPaidMember: false,
      filePreferences: { imageFormat: 'metadata' },
    };
    renderWithProviders(<ImageFormatSelect />);

    await expect.element(page.getByRole('textbox', { name: LABEL })).toHaveValue('Compressed');
  });

  test("reads a paid member's stored choice as Lossless", async () => {
    currentUser.value = { id: 7, isPaidMember: true, filePreferences: { imageFormat: 'metadata' } };
    renderWithProviders(<ImageFormatSelect />);

    await expect.element(page.getByRole('textbox', { name: LABEL })).toHaveValue('Lossless');
  });

  test('sends a non-member to pricing and writes nothing', async () => {
    renderWithProviders(<ImageFormatSelect />);

    await openOptions();
    await userEvent.click(page.getByRole('option', { name: /Lossless/ }));

    expect(vi.mocked(useRouter().push)).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/pricing',
        query: expect.objectContaining({ utm_campaign: 'media_quality_lossless' }),
      })
    );
    // A write here would raise the "preferences saved" toast for a change to nothing they see.
    expect(mutate).not.toHaveBeenCalled();
  });

  test('saves a paid member’s pick instead of routing them', async () => {
    currentUser.value = { id: 7, isPaidMember: true, filePreferences: {} };
    renderWithProviders(<ImageFormatSelect />);

    await openOptions();
    await userEvent.click(page.getByRole('option', { name: /Lossless/ }));

    expect(mutate).toHaveBeenCalledWith({ id: 7, filePreferences: { imageFormat: 'metadata' } });
    expect(vi.mocked(useRouter().push)).not.toHaveBeenCalled();
  });

  test('clears the optimistic value when the save is rejected', async () => {
    // The local override exists to cover the session round-trip, so nothing else ever clears it:
    // without the rollback the select sits on a preference that was never persisted, and with no
    // global mutation error handler the failure is otherwise silent.
    currentUser.value = { id: 7, isPaidMember: true, filePreferences: {} };
    renderWithProviders(<ImageFormatSelect />);

    await openOptions();
    await userEvent.click(page.getByRole('option', { name: /Lossless/ }));
    await expect.element(page.getByRole('textbox', { name: LABEL })).toHaveValue('Lossless');

    capturedMutationOptions.value?.onError?.();

    await expect.element(page.getByRole('textbox', { name: LABEL })).toHaveValue('Compressed');
    expect(showErrorNotification).toHaveBeenCalled();
  });
});
