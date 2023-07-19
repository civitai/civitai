import { Menu, useMantineTheme } from '@mantine/core';
import { IconPlaylistAdd } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

export function AddToCollectionMenuItem({ onClick }: Props) {
  const theme = useMantineTheme();

  return (
    <LoginRedirect reason="add-to-collection">
      <Menu.Item
        icon={
          <IconPlaylistAdd
            size={16}
            stroke={1.5}
            color={theme.colors.pink[theme.fn.primaryShade()]}
          />
        }
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
      >
        Add to collection
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = { onClick: VoidFunction };
