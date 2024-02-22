import { ActionIcon, Menu } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { useRef } from 'react';

type ImageContextMenuProps = {
  userId?: number;
  user?: { id: number };
  url?: string | null;
  collectionId?: number;
  needsReview?: string;
};

type CustomMenuItem<TProps extends Record<string, unknown> = any> = {
  component: React.ComponentType<TProps>;
  props?: TProps;
};

function createMenuItem<TProps extends Record<string, unknown>>(props: CustomMenuItem<TProps>) {
  return props;
}

export function ImageContextMenu(props: ImageContextMenuProps) {
  // const userMenuItemsRef = useRef([
  //   createMenuItem({
  //     component:
  //   })
  // ])

  return (
    <Menu>
      <Menu.Target>
        <ActionIcon variant="transparent">
          <IconDotsVertical
            size={26}
            color="#fff"
            filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
          />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown></Menu.Dropdown>
    </Menu>
  );
}
