import { ActionIcon } from '@mantine/core';
import { openContext } from '~/providers/CustomModalsProvider';
import React, { useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { IconSettings } from '@tabler/icons-react';

export function ManageHomeBlockAction({
  children,
  ...props
}: {
  children?: (props: { onClick: (e: React.MouseEvent) => void }) => React.ReactNode;
}) {
  const currentUser = useCurrentUser();
  const { data: homeBlocks = [] } = trpc.homeBlock.getHomeBlocks.useQuery(
    {},
    {
      enabled: !!currentUser,
    }
  );

  const hasUserHomeBlocks = useMemo(() => {
    if (!currentUser) {
      return false;
    }

    return homeBlocks.find((homeBlock) => homeBlock.userId === currentUser.id);
  }, [currentUser, homeBlocks]);

  if (!hasUserHomeBlocks) {
    return null;
  }

  const onClick = () => {
    openContext('manageHomeBlocks', {});
  };

  if (children) {
    return <>children({onClick})</>;
  }

  return (
    <ActionIcon size="sm" variant="light" color="dark" onClick={onClick} {...props}>
      <IconSettings />
    </ActionIcon>
  );
}
