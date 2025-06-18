import { Menu } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useMutateCollection } from '~/components/Collections/collection.utils';

export function RemoveFromCollectionMenuItem({ collectionId, itemId }: Props) {
  const { removeCollectionItem } = useMutateCollection();

  const handleRemoval = async () => {
    removeCollectionItem({ collectionId, itemId });
  };

  return (
    <Menu.Item
      leftSection={<IconTrash size={14} stroke={1.5} />}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        handleRemoval();
      }}
    >
      Remove from this Collection
    </Menu.Item>
  );
}

type Props = { collectionId: number; itemId: number };
