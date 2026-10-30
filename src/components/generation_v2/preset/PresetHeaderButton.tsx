import type { CSSProperties } from 'react';
import { useState } from 'react';
import { Menu, Text, Tooltip } from '@mantine/core';
import { IconBookmark, IconDeviceFloppy, IconEye, IconList } from '@tabler/icons-react';
import clsx from 'clsx';

import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import { SheetOption } from '~/components/Drawer/SheetOption';
import { ManagePresetsModal } from '~/components/generation_v2/preset/ManagePresetsModal';
import { PresetPickerModal } from '~/components/generation_v2/preset/PresetPickerModal';
import { SavePresetModal } from '~/components/generation_v2/preset/SavePresetModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGeneratorLayout } from '~/hooks/useMobileGenerator';
import { useGenerationPresetStore } from '~/store/generation-preset.store';
import { trpc } from '~/utils/trpc';

/** Yellow nudge color — reads as "new feature, check this out". */
const GLOW_COLOR_RGB = '250, 204, 21';

export const openPresetPicker = () =>
  dialogStore.trigger({ id: 'preset-picker', component: PresetPickerModal });
export const openSavePreset = () =>
  dialogStore.trigger({ id: 'save-preset', component: SavePresetModal });
export const openManagePresets = () =>
  dialogStore.trigger({ id: 'manage-presets', component: ManagePresetsModal });

/**
 * Icon-only trigger in the generation tabs header (the form's title row in the mobile generator,
 * where the menu is a sheet). Opens a dropdown menu with:
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
  const mobile = useGeneratorLayout() === 'mobile';

  // Query the user's presets; skip for signed-out visitors.
  const presetsQuery = trpc.generationPreset.getOwn.useQuery(undefined, {
    enabled: !!currentUser,
  });
  // Glow only once we actually know the user has no presets (not while loading).
  const showGlow = presetsQuery.isSuccess && presetsQuery.data.length === 0;

  if (!currentUser) return null;

  const icon = (
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
  );

  if (mobile) {
    const choose = (action: () => void) => () => {
      setMenuOpened(false);
      action();
    };
    return (
      <PopoverOrSheet
        opened={menuOpened}
        onClose={() => setMenuOpened(false)}
        title="Presets"
        target={
          <LegacyActionIcon aria-label="Presets" size="lg" onClick={() => setMenuOpened(true)}>
            {icon}
          </LegacyActionIcon>
        }
      >
        <div className="flex flex-col">
          <SheetOption selected={false} onClick={choose(openPresetPicker)}>
            <span className="flex items-center gap-3">
              <IconEye size={20} />
              View presets
            </span>
          </SheetOption>
          <SheetOption selected={false} onClick={choose(openSavePreset)} disabled={!canSave}>
            <span className="flex items-center gap-3">
              <IconDeviceFloppy size={20} />
              Save current values
            </span>
          </SheetOption>
          <SheetOption selected={false} onClick={choose(openManagePresets)}>
            <span className="flex items-center gap-3">
              <IconList size={20} />
              Manage presets
            </span>
          </SheetOption>
        </div>
      </PopoverOrSheet>
    );
  }

  return (
    <Menu
      shadow="md"
      width={220}
      position="bottom-start"
      opened={menuOpened}
      onChange={setMenuOpened}
    >
      {/* Tooltip WRAPS Menu.Target, not the other way round — the inner nesting
          silently stops the menu opening. See AppListingActionsMenu.tsx. */}
      <Tooltip label="Presets" disabled={menuOpened}>
        <Menu.Target>
          <LegacyActionIcon aria-label="Presets">{icon}</LegacyActionIcon>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconEye size={14} />} onClick={openPresetPicker}>
          View presets
        </Menu.Item>
        <Menu.Item
          leftSection={<IconDeviceFloppy size={14} />}
          onClick={openSavePreset}
          disabled={!canSave}
        >
          Save current values
        </Menu.Item>
        <Menu.Item leftSection={<IconList size={14} />} onClick={openManagePresets}>
          Manage presets
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
