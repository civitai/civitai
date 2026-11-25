import { Menu } from '~/components/MantineOverlays';
import { IconLayoutNavbar, IconLayoutGrid, IconSettings } from '@tabler/icons-react';
import { openDialog } from '~/components/Dialog/openDialog';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';

/**
 * Both modals are lazy. This button mounts on nearly every route now — the homepage gear it
 * replaces mounted on one — so a static import would put `@dnd-kit` in the app-shell chunk for
 * every visitor, anonymous included.
 */
const openSubNavSettings = () =>
  openDialog(() => import('~/components/HomeContentToggle/SubNavSettingsModal'));

/**
 * `withHomepageOption` is passed only from the route that already had a gear of its own, where a
 * single icon would otherwise have to mean two different things.
 */
export function SubNavSettingsButton({
  withHomepageOption,
  className,
}: {
  withHomepageOption?: boolean;
  className?: string;
}) {
  const currentUser = useCurrentUser();
  // Before anything else: there is nowhere to persist a layout for a signed-out visitor, and
  // keeping this branch first is what keeps the modal chunk off their page.
  if (!currentUser) return null;

  if (!withHomepageOption)
    return (
      <LegacyActionIcon
        size={32}
        radius="xl"
        variant="subtle"
        // `bright`, not `LegacyActionIcon`'s grey. Measured 2026-09-15 in DARK: the grey put this
        // at rgb(222,226,230) beside the nav's other icons at rgb(254,254,254), which at a matched
        // 16px box reads as a smaller icon rather than a dimmer one. `bright` is the theme's
        // black/white pair, the same one the pills use, so it tracks them in both schemes.
        c="var(--mantine-color-bright)"
        className={className}
        aria-label="Customize navigation"
        onClick={() => openSubNavSettings()}
      >
        <IconSettings size={16} />
      </LegacyActionIcon>
    );

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <LegacyActionIcon
          size={32}
          radius="xl"
          variant="subtle"
          c="var(--mantine-color-bright)"
          className={className}
          aria-label="Customize page and navigation"
        >
          <IconSettings size={16} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconLayoutGrid size={16} />}
          onClick={() => openDialog(() => import('~/components/HomeBlocks/ManageHomeBlocksModal'))}
        >
          Customize homepage
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLayoutNavbar size={16} />}
          onClick={() => openSubNavSettings()}
        >
          Customize navigation
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
