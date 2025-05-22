import { ActionIconProps } from '@mantine/core';
import { IconSettings, IconProps } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';

export function ManageHomepageButton({
  iconProps,
  ...actionIconProps
}: ActionIconProps & { iconProps?: IconProps }) {
  const user = useCurrentUser();
  if (!user) return null;

  return (
    <LegacyActionIcon
      size="md"
      variant="subtle"
      color="gray"
      {...actionIconProps}
      onClick={() => openContext('manageHomeBlocks', {})}
    >
      <IconSettings {...iconProps} />
    </LegacyActionIcon>
  );
}
