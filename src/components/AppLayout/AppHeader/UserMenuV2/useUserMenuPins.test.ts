// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserSettingsHooks from '~/components/UserSettings/hooks';
import {
  DEFAULT_USER_MENU_PINS,
  type UserMenuItemId,
} from '~/shared/constants/user-menu.constants';

/**
 * The pins a viewer sees and what reaches `user.setSettings`. The settings hooks are replaced: the
 * state hook by a holder a test sets, the mutation by a recorder, so "how many writes, carrying
 * what" is observable without a server. The default-pins query is a holder too.
 */
type DefaultsQuery = { data?: UserMenuItemId[]; isSuccess: boolean; isError: boolean };
const DB_DEFAULTS: UserMenuItemId[] = ['vault', 'leaderboard'];
const loaded = (): DefaultsQuery => ({ data: DB_DEFAULTS, isSuccess: true, isError: false });

const { settings, defaults, mutate, mutateOptions } = vi.hoisted(() => ({
  settings: {
    value: { settings: undefined, isResolved: true } as {
      settings?: { userMenu?: { pinned: UserMenuItemId[] } };
      isResolved: boolean;
    },
  },
  defaults: { value: undefined as unknown as DefaultsQuery },
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

vi.mock('~/utils/trpc', () => ({
  trpc: { system: { getUserMenuDefaultPins: { useQuery: () => defaults.value } } },
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
  defaults.value = loaded();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useUserMenuPins', () => {
  it('shows the database defaults to someone who never saved pins, and their own list otherwise', () => {
    mount();
    expect(latest.pins).toEqual(DB_DEFAULTS);

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
    act(() => latest.toggle('vault'));

    act(() => latest.flush());
    expect(mutate).toHaveBeenCalledWith({ userMenu: { pinned: ['leaderboard'] } });

    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS * 2));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('saves a pending edit when the menu unmounts before the timer fires', () => {
    mount();
    act(() => latest.toggle('downloads'));

    act(() => root.unmount());
    root = createRoot(document.createElement('div'));

    expect(mutate).toHaveBeenCalledWith({
      userMenu: { pinned: ['vault', 'leaderboard', 'downloads'] },
    });
  });

  it('refuses edits until the saved pins have loaded, so the defaults never overwrite them', () => {
    settings.value = { settings: undefined, isResolved: false };
    mount();

    act(() => latest.toggle('vault'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));

    expect(latest.canEdit).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses a first edit until the database defaults load, so it never starts from the fallback', () => {
    defaults.value = { data: undefined, isSuccess: false, isError: false };
    mount();
    expect(latest.pins).toEqual(DEFAULT_USER_MENU_PINS);

    act(() => latest.toggle('downloads'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
    expect(latest.canEdit).toBe(false);
    expect(mutate).not.toHaveBeenCalled();

    defaults.value = loaded();
    mount();
    act(() => latest.toggle('downloads'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
    expect(mutate).toHaveBeenCalledWith({
      userMenu: { pinned: ['vault', 'leaderboard', 'downloads'] },
    });
  });

  it('lets someone edit from the fallback when the database defaults cannot be read', () => {
    defaults.value = { data: undefined, isSuccess: false, isError: true };
    mount();

    act(() => latest.toggle('downloads'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));

    expect(mutate).toHaveBeenCalledWith({
      userMenu: { pinned: [...DEFAULT_USER_MENU_PINS, 'downloads'] },
    });
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
