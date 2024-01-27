import { ActionIcon, ActionIconProps } from '@mantine/core';
import { IconSettings, TablerIconsProps } from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';

export function ManageHomepageButton({
  iconProps,
  ...actionIconProps
}: ActionIconProps & { iconProps?: TablerIconsProps }) {
  const user = useCurrentUser();
  if (!user) return null;

  return (
    <ActionIcon
      size="md"
      variant="subtle"
      color="dark"
      {...actionIconProps}
      onClick={() => openContext('manageHomeBlocks', {})}
    >
      <IconSettings {...iconProps} />
    </ActionIcon>
  );
}
