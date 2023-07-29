import { ActionIcon } from '@mantine/core';
import { openContext } from '~/providers/CustomModalsProvider';
import React from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { IconSettings } from '@tabler/icons-react';

export function ManageHomeBlockAction({
  children,
  ...props
}: {
  children?: (props: { onClick: (e: React.MouseEvent) => void }) => React.ReactNode;
}) {
  const currentUser = useCurrentUser();
  if (!currentUser) {
    return;
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
