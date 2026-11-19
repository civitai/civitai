// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserSettingsHooks from '~/components/UserSettings/hooks';
import type * as Notifications from '~/utils/notifications';
import { PIN_SAVE_DELAY_MS } from '~/components/AppLayout/AppHeader/UserMenuV2/useUserMenuPins';
import { REMIX_PINS_MAX } from '~/shared/remix-apps/menu';

const { settings, mutate, mutateOptions, notifyError } = vi.hoisted(() => ({
  settings: {
    value: { settings: undefined, isResolved: true } as {
      settings?: { remixApps?: { pinned?: string[] } };
      isResolved: boolean;
    },
  },
  mutate: vi.fn(),
  mutateOptions: { value: undefined as undefined | { onError?: (error: Error) => void } },
  notifyError: vi.fn(),
}));

vi.mock('~/components/UserSettings/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof UserSettingsHooks>()),
  useCurrentUserSettingsState: () => settings.value,
  useMutateUserSettings: (options?: { onError?: (error: Error) => void }) => {
    mutateOptions.value = options;
    return { mutate };
  },
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: notifyError,
}));

const { useRemixAppPins } = await import('./useRemixAppPins');

let latest: ReturnType<typeof useRemixAppPins>;
let root: Root;
function Harness() {
  latest = useRemixAppPins();
  return null;
}
const mount = () => act(() => root.render(createElement(Harness)));
const settle = () => act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS + 1));
const saved = (pinned: string[]) => ({ settings: { remixApps: { pinned } }, isResolved: true });

beforeEach(() => {
  vi.useFakeTimers();
  mutate.mockReset();
  notifyError.mockReset();
  settings.value = { settings: undefined, isResolved: true };
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useRemixAppPins', () => {
  it('refuses a pin past the cap with a message, and keeps every existing pin', () => {
    const full = Array.from({ length: REMIX_PINS_MAX }, (_, i) => `app-${i}`);
    settings.value = saved(full);
    mount();

    act(() => latest.toggle('one-more', full));
    settle();

    expect(latest.pins).toEqual(full);
    expect(mutate).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('at the cap, replaces a pin the viewer cannot see here rather than refusing', () => {
    const full = Array.from({ length: REMIX_PINS_MAX }, (_, i) => `app-${i}`);
    settings.value = saved(full);
    mount();

    // app-3 is pinned but not offered (disabled, gone, or not for this image).
    act(() =>
      latest.toggle(
        'one-more',
        full.filter((slug) => slug !== 'app-3')
      )
    );
    settle();

    expect(notifyError).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith({
      remixApps: { pinned: [...full.filter((slug) => slug !== 'app-3'), 'one-more'] },
    });
  });

  it('still unpins at the cap', () => {
    const full = Array.from({ length: REMIX_PINS_MAX }, (_, i) => `app-${i}`);
    settings.value = saved(full);
    mount();

    act(() => latest.toggle('app-0'));
    settle();

    expect(mutate).toHaveBeenCalledWith({ remixApps: { pinned: full.slice(1) } });
  });

  it('refuses every edit until settings resolve, so the saved pins are not overwritten', () => {
    settings.value = { settings: undefined, isResolved: false };
    mount();
    expect(latest.canEdit).toBe(false);

    act(() => latest.toggle('app-a'));
    settle();

    expect(latest.pins).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows an edit at once, and falls back to the saved pins when the save fails', () => {
    settings.value = saved(['app-a']);
    mount();

    act(() => latest.toggle('app-b'));
    expect(latest.pins).toEqual(['app-a', 'app-b']);
    settle();
    expect(mutate).toHaveBeenCalledWith({ remixApps: { pinned: ['app-a', 'app-b'] } });

    act(() => mutateOptions.value?.onError?.(new Error('boom')));
    expect(latest.pins).toEqual(['app-a']);
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});
