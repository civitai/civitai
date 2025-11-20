import type { ActionIconProps } from '@mantine/core';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { IconProps } from '@tabler/icons-react';
import { IconSettings } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const ManageHomeBlocksModal = dynamic(
  () => import('~/components/HomeBlocks/ManageHomeBlocksModal'),
  { ssr: false }
);
const openManageHomeBlocksModal = createDialogTrigger(ManageHomeBlocksModal);

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
