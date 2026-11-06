// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserSettingsHooks from '~/components/UserSettings/hooks';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import {
  DEFAULT_USER_MENU_PINS,
  type UserMenuBadgeItemId,
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
      settings?: { userMenu?: { pinned?: UserMenuItemId[]; mutedBadges?: UserMenuBadgeItemId[] } };
      isResolved: boolean;
    },
  },
  defaults: {
    value: undefined as unknown as DefaultsQuery,
    enabled: undefined as unknown as boolean,
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

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    // A disabled query never settles, as in react-query, so a gate that waits on it shows here.
    'system.getUserMenuDefaultPins': {
      useQuery: (_input: undefined, options: { enabled: boolean }) => {
        defaults.enabled = options.enabled;
        return options.enabled ? defaults.value : { isSuccess: false, isError: false };
      },
    },
  }),
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
      userMenu: { pinned: ['downloads', 'vault', 'liked-models'], mutedBadges: [] },
    });
  });

  it('sends a pending save at once on flush, and not again when the timer would have fired', () => {
    mount();
    act(() => latest.toggle('vault'));

    act(() => latest.flush());
    expect(mutate).toHaveBeenCalledWith({ userMenu: { pinned: ['leaderboard'], mutedBadges: [] } });

    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS * 2));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('saves a pending edit when the menu unmounts before the timer fires', () => {
    mount();
    act(() => latest.toggle('downloads'));

    act(() => root.unmount());
    root = createRoot(document.createElement('div'));

    expect(mutate).toHaveBeenCalledWith({
      userMenu: { pinned: ['vault', 'leaderboard', 'downloads'], mutedBadges: [] },
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
      userMenu: { pinned: ['vault', 'leaderboard', 'downloads'], mutedBadges: [] },
    });
  });

  it('does not ask for the defaults for someone with saved pins, and lets them edit at once', () => {
    settings.value = { settings: { userMenu: { pinned: ['vault'] } }, isResolved: true };
    mount();
    expect(defaults.enabled).toBe(false);

    act(() => latest.toggle('downloads'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));

    expect(mutate).toHaveBeenCalledWith({
      userMenu: { pinned: ['vault', 'downloads'], mutedBadges: [] },
    });
  });

  it('lets someone edit from the fallback when the database defaults cannot be read', () => {
    defaults.value = { data: undefined, isSuccess: false, isError: true };
    mount();

    act(() => latest.toggle('downloads'));
    act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));

    expect(mutate).toHaveBeenCalledWith({
      userMenu: { pinned: [...DEFAULT_USER_MENU_PINS, 'downloads'], mutedBadges: [] },
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

    expect(mutate).toHaveBeenCalledWith({
      userMenu: { pinned: ['vault', 'downloads'], mutedBadges: [] },
    });
  });

  describe('muted counts', () => {
    it('shows nothing muted to someone who never muted, and their saved list otherwise', () => {
      settings.value = { settings: { userMenu: { pinned: ['vault'] } }, isResolved: true };
      mount();
      expect(latest.mutedBadges).toEqual([]);

      settings.value = {
        settings: { userMenu: { pinned: ['vault'], mutedBadges: ['collections'] } },
        isResolved: true,
      };
      mount();
      expect(latest.mutedBadges).toEqual(['collections']);
    });

    it('saves a mute together with the saved pins, once, after a quiet second', () => {
      settings.value = { settings: { userMenu: { pinned: ['vault'] } }, isResolved: true };
      mount();

      act(() => latest.toggleBadgeMute('collections'));
      act(() => latest.toggleBadgeMute('prizes'));
      expect(latest.mutedBadges).toEqual(['collections', 'prizes']);
      expect(mutate).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledWith({
        userMenu: { pinned: ['vault'], mutedBadges: ['collections', 'prizes'] },
      });
    });

    it('unmutes a muted count', () => {
      settings.value = {
        settings: { userMenu: { pinned: ['vault'], mutedBadges: ['collections', 'prizes'] } },
        isResolved: true,
      };
      mount();

      act(() => latest.toggleBadgeMute('collections'));
      expect(latest.mutedBadges).toEqual(['prizes']);
      act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
      expect(mutate).toHaveBeenCalledWith({
        userMenu: { pinned: ['vault'], mutedBadges: ['prizes'] },
      });
    });

    it('keeps the muted counts when the pins change, since userMenu is written whole', () => {
      settings.value = {
        settings: { userMenu: { pinned: ['vault'], mutedBadges: ['collections'] } },
        isResolved: true,
      };
      mount();

      act(() => latest.toggle('downloads'));
      act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
      expect(mutate).toHaveBeenCalledWith({
        userMenu: { pinned: ['vault', 'downloads'], mutedBadges: ['collections'] },
      });
    });

    it('does not freeze default pins when someone only mutes', () => {
      mount();
      act(() => latest.toggleBadgeMute('inventory'));
      act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
      expect(mutate).toHaveBeenCalledWith({
        userMenu: { pinned: undefined, mutedBadges: ['inventory'] },
      });
      expect(latest.pins).toEqual(DB_DEFAULTS);
    });

    it('saves a pin edit and a mute made inside the same quiet second together, in either order', () => {
      settings.value = { settings: { userMenu: { pinned: ['vault'] } }, isResolved: true };
      mount();
      act(() => latest.toggle('downloads'));
      act(() => latest.toggleBadgeMute('prizes'));
      act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenLastCalledWith({
        userMenu: { pinned: ['vault', 'downloads'], mutedBadges: ['prizes'] },
      });

      mutate.mockClear();
      act(() => latest.toggleBadgeMute('collections'));
      act(() => latest.toggle('liked-models'));
      act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenLastCalledWith({
        userMenu: {
          pinned: ['vault', 'downloads', 'liked-models'],
          mutedBadges: ['prizes', 'collections'],
        },
      });
    });

    it('falls back to the saved mutes when a save fails', () => {
      settings.value = {
        settings: { userMenu: { pinned: ['vault'], mutedBadges: ['prizes'] } },
        isResolved: true,
      };
      mount();
      act(() => latest.toggleBadgeMute('collections'));
      expect(latest.mutedBadges).toEqual(['prizes', 'collections']);

      act(() => mutateOptions.value?.onError?.(new Error('offline')));
      expect(latest.mutedBadges).toEqual(['prizes']);
    });

    it('leaves out a saved mute the menu no longer knows, so the write is not rejected', () => {
      const gone = 'retired-item' as UserMenuBadgeItemId;
      settings.value = {
        settings: { userMenu: { pinned: ['vault'], mutedBadges: [gone, 'prizes'] } },
        isResolved: true,
      };
      mount();
      act(() => latest.toggleBadgeMute('collections'));
      act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
      expect(mutate).toHaveBeenCalledWith({
        userMenu: { pinned: ['vault'], mutedBadges: ['prizes', 'collections'] },
      });
    });

    it('refuses a mute until settings resolve', () => {
      settings.value = { settings: undefined, isResolved: false };
      mount();
      act(() => latest.toggleBadgeMute('collections'));
      act(() => vi.advanceTimersByTime(PIN_SAVE_DELAY_MS));
      expect(latest.mutedBadges).toEqual([]);
      expect(mutate).not.toHaveBeenCalled();
    });
  });
});
