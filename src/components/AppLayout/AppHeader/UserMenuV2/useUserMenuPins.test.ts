// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserSettingsHooks from '~/components/UserSettings/hooks';
import type { UserMenuItemId } from '~/shared/constants/user-menu.constants';

/**
 * The pins a viewer sees and what reaches `user.setSettings`. The settings hooks are replaced: the
 * state hook by a holder a test sets, the mutation by a recorder, so "how many writes, carrying
 * what" is observable without a server.
 */
const { settings, mutate, mutateOptions } = vi.hoisted(() => ({
  settings: {
    value: { settings: undefined, isResolved: true } as {
      settings?: { userMenu?: { pinned: UserMenuItemId[] } };
      isResolved: boolean;
    },
  },
  mutate: vi.fn(),
  mutateOptions: { value: undefined as undefined | { onError?: (error: Error) => void } },
}));

vi.mock('~/components/UserSettings/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof UserSettingsHooks>()),
  useCurrentUserSettingsState: () => settings.value,
  useMutateUserSettings: (options?: { onError?: (error: Error) => void }) => {
    mutateOptions.value = options;
    return { mutate };
  },
}));

const { useUserMenuPins, PIN_SAVE_DELAY_MS } = await import('./useUserMenuPins');

let latest: ReturnType<typeof useUserMenuPins>;
let root: Root;
function Harness() {
  latest = useUserMenuPins();
  return null;
}
const mount = () => act(() => root.render(createElement(Harness)));

beforeEach(() => {
  vi.useFakeTimers();
  mutate.mockReset();
  settings.value = { settings: undefined, isResolved: true };
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useUserMenuPins', () => {
  it('shows Inventory and Prizes to someone who never saved pins, and their own list otherwise', () => {
    mount();
    expect(latest.pins).toEqual(['inventory', 'prizes']);

    settings.value = { settings: { userMenu: { pinned: [] } }, isResolved: true };
    mount();
    expect(latest.pins).toEqual([]);
  });

  it('shows each edit at once and saves the last one once, after a quiet second', () => {
    settings.value = { settings: { userMenu: { pinned: ['vault'] } }, isResolved: true };
    mount();

    act(() => latest.toggle('liked-models'));
    act(() => latest.toggle('downloads'));
    act(() => latest.move('downloads', 'vault'));

    expect(latest.pins).toEqual(['downloads', 'vault', 'liked-models']);
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS - 1));
    expect(mutate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      userMenu: { pinned: ['downloads', 'vault', 'liked-models'] },
    });
  });

  it('sends a pending save at once on flush, and not again when the timer would have fired', () => {
    mount();
    act(() => latest.toggle('inventory'));

    act(() => latest.flush());
    expect(mutate).toHaveBeenCalledWith({ userMenu: { pinned: ['prizes'] } });

    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS * 2));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('saves a pending edit when the menu unmounts before the timer fires', () => {
    mount();
    act(() => latest.toggle('vault'));

    act(() => root.unmount());
    root = createRoot(document.createElement('div'));

    expect(mutate).toHaveBeenCalledWith({ userMenu: { pinned: ['inventory', 'prizes', 'vault'] } });
  });

  it('refuses edits until the saved pins have loaded, so the defaults never overwrite them', () => {
    settings.value = { settings: undefined, isResolved: false };
    mount();

    act(() => latest.toggle('vault'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));

    expect(latest.canEdit).toBe(false);
    expect(latest.pins).toEqual(['inventory', 'prizes']);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('falls back to the saved pins when the save fails', () => {
    settings.value = { settings: { userMenu: { pinned: ['vault'] } }, isResolved: true };
    mount();
    act(() => latest.toggle('downloads'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
    expect(latest.pins).toEqual(['vault', 'downloads']);

    act(() => mutateOptions.value?.onError?.(new Error('offline')));

    expect(latest.pins).toEqual(['vault']);
  });

  it('leaves out a saved id the menu no longer knows, so the write is not rejected', () => {
    const gone = 'retired-item' as UserMenuItemId;
    settings.value = { settings: { userMenu: { pinned: [gone, 'vault'] } }, isResolved: true };
    mount();

    act(() => latest.toggle('downloads'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));

    expect(mutate).toHaveBeenCalledWith({ userMenu: { pinned: ['vault', 'downloads'] } });
  });
});
