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
 * disabled or gone stays saved, so the app comes back pinned if it returns. At the cap, a new pin
 * replaces a pin the viewer cannot see, or is refused with a message.
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

  /** `offered`: the slugs the viewer can see and unpin here, which keep their place at the cap. */
  const toggle = (slug: string, offered?: readonly string[]) => {
    if (!isResolved) return;
    const pinned = pins.includes(slug);
    let kept = pins;
    if (!pinned && pins.length >= REMIX_PINS_MAX) {
      // A pin the viewer cannot see here could never be unpinned, so it makes room first.
      const hidden = offered && pins.find((p) => !offered.includes(p));
      if (!hidden) {
        showErrorNotification({
          title: `You can pin up to ${REMIX_PINS_MAX} apps`,
          error: new Error('Unpin one to make room.'),
        });
        return;
      }
      kept = pins.filter((p) => p !== hidden);
    }
    const next = pinned ? pins.filter((p) => p !== slug) : [...kept, slug];
    setLocal(next);
    save(next);
  };

  return { pins, toggle, canEdit: isResolved };
}
