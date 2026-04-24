import type { CSSProperties } from 'react';
import { useState } from 'react';
import { Menu, Text, Tooltip } from '@mantine/core';
import { IconBookmark, IconDeviceFloppy, IconEye, IconList } from '@tabler/icons-react';
import clsx from 'clsx';

import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ManagePresetsModal } from '~/components/generation_v2/preset/ManagePresetsModal';
import { PresetPickerModal } from '~/components/generation_v2/preset/PresetPickerModal';
import { SavePresetModal } from '~/components/generation_v2/preset/SavePresetModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGenerationPresetStore } from '~/store/generation-preset.store';
import { trpc } from '~/utils/trpc';

/** Yellow nudge color — reads as "new feature, check this out". */
const GLOW_COLOR_RGB = '250, 204, 21';

/**
 * Icon-only trigger in the generation tabs header. Opens a dropdown menu with:
 * - View presets → opens the picker modal
 * - Save current values → opens the save modal
 * - Manage presets → opens the manage modal
 *
 * Glows to draw attention while the user has zero presets. No persistence —
 * the glow naturally disappears the first time they save a preset.
 */
export function PresetHeaderButton() {
  const currentUser = useCurrentUser();
  const canSave = useGenerationPresetStore((s) => !!s.bridge.getFilteredSnapshot);
  const [menuOpened, setMenuOpened] = useState(false);

  // Query the user's presets; skip for signed-out visitors.
  const presetsQuery = trpc.generationPreset.getOwn.useQuery(undefined, {
    enabled: !!currentUser,
  });
  // Glow only once we actually know the user has no presets (not while loading).
  const showGlow = presetsQuery.isSuccess && presetsQuery.data.length === 0;

  if (!currentUser) return null;

  const openPicker = () =>
    dialogStore.trigger({ id: 'preset-picker', component: PresetPickerModal });
  const openSave = () =>
    dialogStore.trigger({ id: 'save-preset', component: SavePresetModal });
  const openManage = () =>
    dialogStore.trigger({ id: 'manage-presets', component: ManagePresetsModal });

  return (
    <Menu
      shadow="md"
      width={220}
      position="bottom-start"
      opened={menuOpened}
      onChange={setMenuOpened}
    >
      <Menu.Target>
        <Tooltip label="Presets" disabled={menuOpened}>
          <LegacyActionIcon>
            <Text c="dimmed" inline>
              <IconBookmark
                className={clsx(showGlow && 'animate-icon-glow')}
                // Setting `color` colors the stroke itself (tabler icons use
                // `currentColor`), so the bookmark lines ARE the glow color —
                // the animated filter just pulses the intensity around them.
                style={
                  showGlow
                    ? ({
                        '--icon-glow-color': GLOW_COLOR_RGB,
                        color: `rgb(${GLOW_COLOR_RGB})`,
                      } as CSSProperties)
                    : undefined
                }
              />
            </Text>
          </LegacyActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconEye size={14} />} onClick={openPicker}>
          View presets
        </Menu.Item>
        <Menu.Item
          leftSection={<IconDeviceFloppy size={14} />}
          onClick={openSave}
          disabled={!canSave}
        >
          Save current values
        </Menu.Item>
        <Menu.Item leftSection={<IconList size={14} />} onClick={openManage}>
          Manage presets
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
