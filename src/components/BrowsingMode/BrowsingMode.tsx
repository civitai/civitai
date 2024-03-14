import {
  Group,
  Text,
  Stack,
  Switch,
  Popover,
  ActionIcon,
  Checkbox,
  Divider,
  Modal,
} from '@mantine/core';
import { IconEyeExclamation, TablerIconsProps } from '@tabler/icons-react';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { useBrowsingModeContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingLevelsGrouped } from '~/components/BrowsingLevel/BrowsingLevelsGrouped';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';

export function BrowsingModeIcon({ iconProps = {} }: BrowsingModeIconProps) {
  const currentUser = useCurrentUser();
  if (!currentUser) return null;
  return (
    <Popover zIndex={constants.imageGeneration.drawerZIndex + 1} withArrow withinPortal>
      <Popover.Target>
        <ActionIcon>
          <IconEyeExclamation {...iconProps} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p="md">
        <BrowsingModeMenu />
      </Popover.Dropdown>
    </Popover>
  );
}
type BrowsingModeIconProps = {
  iconProps?: TablerIconsProps;
};

export function BrowsingModeMenu() {
  const { toggleBlurNsfw, toggleShowNsfw, toggleDisableHidden } = useBrowsingModeContext();
  const currentUser = useCurrentUser();
  const showNsfw = currentUser?.showNsfw;
  const blurNsfw = currentUser?.blurNsfw;
  const disableHidden = currentUser?.disableHidden;

  const handleHiddenFiltersClick = () => {
    dialogStore.trigger({
      component: HiddenTagsModal,
      target: '#browsing-mode',
    });
  };

  return (
    <div id="browsing-mode">
      <Stack spacing="md" className="min-w-96">
        <Group position="apart">
          <Group align="center" spacing={4}>
            <IconEyeExclamation />
            <Text>Mature Content</Text>
          </Group>
          <Switch checked={showNsfw} onChange={(e) => toggleShowNsfw(e.target.checked)} />
        </Group>
        <Divider />
        {showNsfw && (
          <Stack spacing="lg">
            <BrowsingLevelsGrouped />
            <Checkbox
              checked={blurNsfw}
              onChange={(e) => toggleBlurNsfw(e.target.checked)}
              label="Blur mature content"
              size="md"
            />
          </Stack>
        )}

        <Group position="apart">
          <Checkbox
            checked={!disableHidden}
            onChange={(e) => toggleDisableHidden(!e.target.checked)}
            label="Apply hidden tags filter"
            size="md"
          />
          <Text
            variant="link"
            className="hover:cursor-pointer"
            underline
            onClick={handleHiddenFiltersClick}
          >
            My filters
          </Text>
        </Group>
      </Stack>
    </div>
  );
}

function HiddenTagsModal() {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} size={1000}>
      <HiddenTagsSection />
    </Modal>
  );
}
