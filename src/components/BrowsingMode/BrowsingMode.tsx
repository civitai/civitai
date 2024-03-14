import { Group, Text, Stack, Switch, Popover, ActionIcon, Checkbox } from '@mantine/core';
import { IconEyeExclamation, TablerIconsProps } from '@tabler/icons-react';
import { useBrowsingModeContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingLevelsGrouped } from '~/components/BrowsingLevel/BrowsingLevelsGrouped';
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

  return (
    <Stack spacing="md">
      <Group position="apart">
        <Group align="center" spacing={4}>
          <IconEyeExclamation />
          <Text>Mature Content</Text>
        </Group>
        <Switch checked={showNsfw} onChange={(e) => toggleShowNsfw(e.target.checked)} />
      </Group>
      {showNsfw && (
        <>
          <BrowsingLevelsGrouped />
          <Checkbox
            checked={blurNsfw}
            onChange={(e) => toggleBlurNsfw(e.target.checked)}
            label="Blur mature content"
          />
        </>
      )}

      <Checkbox
        checked={!disableHidden}
        onChange={(e) => toggleDisableHidden(!e.target.checked)}
        label="Apply hidden tags filter"
      />
    </Stack>
  );
}
