import { useState } from 'react';
import { Menu, Text, Tooltip } from '@mantine/core';
import { IconBookmark, IconDeviceFloppy, IconEye, IconList } from '@tabler/icons-react';

import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ManagePresetsModal } from '~/components/generation_v2/preset/ManagePresetsModal';
import { PresetPickerModal } from '~/components/generation_v2/preset/PresetPickerModal';
import { SavePresetModal } from '~/components/generation_v2/preset/SavePresetModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGenerationPresetStore } from '~/store/generation-preset.store';

/**
 * Icon-only trigger in the generation tabs header. Opens a dropdown menu with:
 * - View presets → opens the picker modal
 * - Save current values → opens the save modal
 * - Manage presets → opens the manage modal
 */
export function PresetHeaderButton() {
  const currentUser = useCurrentUser();
  const canSave = useGenerationPresetStore((s) => !!s.bridge.getFilteredSnapshot);
  const [menuOpened, setMenuOpened] = useState(false);

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
              <IconBookmark />
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
