import { useDebouncedCallback } from '@mantine/hooks';
import { useState } from 'react';
import {
  useCurrentUserSettingsState,
  useMutateUserSettings,
} from '~/components/UserSettings/hooks';
import {
  DEFAULT_USER_MENU_PINS,
  isUserMenuItemId,
  type UserMenuItemId,
} from '~/shared/constants/user-menu.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { movePin, togglePin } from './resolveUserMenu';

export const PIN_SAVE_DELAY_MS = 1000;

/**
 * Edits show at once and save after `PIN_SAVE_DELAY_MS` of quiet; `flush` saves now (menu close).
 * Edits are refused until settings resolve: an earlier one would start from the defaults and
 * overwrite the viewer's real pins. A viewer with no saved pins also waits for the default pins,
 * so a first edit starts from what the database says rather than from the fallback.
 */
export function useUserMenuPins() {
  const { settings, isResolved: settingsResolved } = useCurrentUserSettingsState();
  const saved = settings?.userMenu?.pinned;
  const defaults = trpc.system.getUserMenuDefaultPins.useQuery(undefined, {
    enabled: settingsResolved && !saved,
  });
  // A failed read settles on the fallback rather than leaving the menu uneditable.
  const isResolved = settingsResolved && (!!saved || defaults.isSuccess || defaults.isError);
  const [local, setLocal] = useState<UserMenuItemId[] | null>(null);
  const pins = local ?? saved ?? defaults.data ?? DEFAULT_USER_MENU_PINS;

  // A failed save falls back to the saved pins rather than showing ones that never landed.
  const { mutate } = useMutateUserSettings({
    onError: (error) => {
      setLocal(null);
      showErrorNotification({ title: 'Could not save your pins', error: new Error(error.message) });
    },
  });
  const save = useDebouncedCallback(
    // A saved id that has since left `USER_MENU_ITEM_IDS` would fail the write schema for good.
    (pinned: UserMenuItemId[]) => mutate({ userMenu: { pinned: pinned.filter(isUserMenuItemId) } }),
    { delay: PIN_SAVE_DELAY_MS, flushOnUnmount: true }
  );

  const update = (next: UserMenuItemId[]) => {
    if (!isResolved) return;
    setLocal(next);
    save(next);
  };

  return {
    pins,
    canEdit: isResolved,
    toggle: (id: UserMenuItemId) => update(togglePin(pins, id)),
    move: (id: UserMenuItemId, overId: UserMenuItemId) => update(movePin(pins, id, overId)),
    // Read at call time: the debouncer swaps its `flush` on every call.
    flush: () => save.flush(),
  };
}
