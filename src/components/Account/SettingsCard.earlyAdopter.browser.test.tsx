import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The early-adopter switch on the account settings page.
 *
 * Two things are load-bearing and neither is visible from the server tests: the switch has
 * to REFLECT the stored value (a switch that always renders off tells an opted-in user they
 * are not enrolled), and toggling it has to send the boolean the schema expects AND ask the
 * session to re-pull — the session is where `isEarlyAdopter` is actually read from, so
 * without that refresh this tab keeps evaluating flags against the old value.
 */

const { mutate, refresh, settings, capturedMutationOptions } = vi.hoisted(() => ({
  mutate: vi.fn(),
  refresh: vi.fn(async () => null),
  settings: { value: {} as Record<string, unknown> },
  capturedMutationOptions: { value: undefined as undefined | Record<string, unknown> },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 7, filePreferences: {}, refresh }),
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
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));
// Capture the options `useMutateUserSettings` passes through so the onSuccess wiring can be
// asserted, and serve the settings the card reads. Everything else keeps its real export.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      user: {
        getSettings: { getData: () => settings.value, setData: vi.fn(), invalidate: vi.fn() },
        getFeatureFlags: {
          getData: () => ({}),
          setData: vi.fn(),
          invalidate: vi.fn(),
          cancel: vi.fn(),
        },
      },
      model: { getAll: { invalidate: vi.fn() } },
    }),
    user: {
      getSettings: { useQuery: () => ({ data: settings.value }) },
      setSettings: {
        useMutation: (options?: Record<string, unknown>) => {
          capturedMutationOptions.value = options;
          return { mutate, isPending: false };
        },
      },
      update: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      toggleFeature: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

import { SettingsCard } from '~/components/Account/SettingsCard';

const SWITCH_NAME = 'Join the early-adopter program';

beforeEach(() => {
  vi.clearAllMocks();
  settings.value = {};
  capturedMutationOptions.value = undefined;
});

describe('SettingsCard — early-adopter toggle', () => {
  test('renders, unchecked, for a user who has not opted in', async () => {
    renderWithProviders(<SettingsCard />);

    const sw = page.getByRole('switch', { name: SWITCH_NAME });
    await expect.element(sw).toBeInTheDocument();
    await expect.element(sw).not.toBeChecked();
  });

  test('renders CHECKED for a user who has opted in', async () => {
    // The stored value has to drive the control. A hardcoded `checked={false}` would pass
    // the test above and still be wrong for every enrolled user.
    settings.value = { isEarlyAdopter: true };
    renderWithProviders(<SettingsCard />);

    await expect.element(page.getByRole('switch', { name: SWITCH_NAME })).toBeChecked();
  });

  test('turning it ON sends isEarlyAdopter: true', async () => {
    renderWithProviders(<SettingsCard />);

    await userEvent.click(page.getByRole('switch', { name: SWITCH_NAME }));

    expect(mutate).toHaveBeenCalledTimes(1);
    // The literal payload the tRPC input schema accepts — a string would be rejected.
    expect(mutate).toHaveBeenCalledWith({ isEarlyAdopter: true });
  });

  test('turning it OFF sends isEarlyAdopter: false, not an omitted key', async () => {
    // Omitting the key would leave the stored `true` untouched (the write is a jsonb merge),
    // so opting out has to send an explicit false.
    settings.value = { isEarlyAdopter: true };
    renderWithProviders(<SettingsCard />);

    await userEvent.click(page.getByRole('switch', { name: SWITCH_NAME }));

    expect(mutate).toHaveBeenCalledWith({ isEarlyAdopter: false });
  });

  test('the mutation is wired to refresh the session on success', async () => {
    // The value is read off the SESSION, not off the getSettings cache the mutation patches.
    // Without this, the tab that made the change is the one place still evaluating flags
    // against the old value.
    renderWithProviders(<SettingsCard />);
    await userEvent.click(page.getByRole('switch', { name: SWITCH_NAME }));

    const onSuccess = capturedMutationOptions.value?.onSuccess as undefined | (() => void);
    expect(onSuccess).toBeTypeOf('function');
    expect(refresh).not.toHaveBeenCalled();
    onSuccess?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('the switch carries a description explaining what opting in means', async () => {
    // An opt-in that does not say what it opts you into is not consent. Assert there is
    // real explanatory copy, not just the label.
    renderWithProviders(<SettingsCard />);

    await expect.element(page.getByText(/before they roll out to everyone/i)).toBeInTheDocument();
  });
});
