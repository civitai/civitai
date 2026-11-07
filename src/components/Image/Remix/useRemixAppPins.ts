import { useDebouncedCallback } from '@mantine/hooks';
import { useState } from 'react';
import { PIN_SAVE_DELAY_MS } from '~/components/AppLayout/AppHeader/UserMenuV2/useUserMenuPins';
import {
  useCurrentUserSettingsState,
  useMutateUserSettings,
} from '~/components/UserSettings/hooks';
import { REMIX_PINS_MAX } from '~/shared/remix-apps/menu';
import { showErrorNotification } from '~/utils/notifications';

const NO_PINS: string[] = [];

/**
 * The viewer's pinned remix apps, as `useUserMenuPins` keeps the user menu's: edits show at once
 * and save after a quiet spell, are refused until settings resolve (an earlier edit would
 * overwrite the saved pins), and a failed save falls back to what is saved. A pin whose app is
 * disabled or gone stays saved, so the app comes back pinned if it returns.
 */
export function useRemixAppPins() {
  const { settings, isResolved } = useCurrentUserSettingsState();
  const saved = settings?.remixApps?.pinned ?? NO_PINS;
  const [local, setLocal] = useState<string[] | null>(null);
  const pins = local ?? saved;

  const { mutate } = useMutateUserSettings({
    onError: (error) => {
      setLocal(null);
      showErrorNotification({ title: 'Could not save your pins', error: new Error(error.message) });
    },
  });
  const save = useDebouncedCallback((pinned: string[]) => mutate({ remixApps: { pinned } }), {
    delay: PIN_SAVE_DELAY_MS,
    flushOnUnmount: true,
  });

  const toggle = (slug: string) => {
    if (!isResolved) return;
    const next = pins.includes(slug)
      ? pins.filter((pinned) => pinned !== slug)
      : // A new pin goes last; past the cap, the oldest pins make room.
        [...pins, slug].slice(-REMIX_PINS_MAX);
    setLocal(next);
    save(next);
  };

  return { pins, toggle, canEdit: isResolved };
}
