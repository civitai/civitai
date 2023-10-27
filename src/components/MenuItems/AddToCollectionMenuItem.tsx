import { Menu, useMantineTheme } from '@mantine/core';
import { IconPlaylistAdd } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

export function AddToCollectionMenuItem({ onClick }: Props) {
  const theme = useMantineTheme();

  return (
    <LoginRedirect reason="add-to-collection">
      <Menu.Item
        icon={<IconPlaylistAdd size={14} stroke={1.5} />}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
      >
        Save
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = { onClick: VoidFunction };
