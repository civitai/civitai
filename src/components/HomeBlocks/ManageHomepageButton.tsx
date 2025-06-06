import type { ActionIconProps } from '@mantine/core';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { IconProps } from '@tabler/icons-react';
import { IconSettings } from '@tabler/icons-react';
import { openManageHomeBlocksModal } from '~/components/Dialog/dialog-registry';
import { useCurrentUser } from '~/hooks/useCurrentUser';

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
      onClick={() => openManageHomeBlocksModal()}
    >
      <IconSettings {...iconProps} />
    </LegacyActionIcon>
  );
}
