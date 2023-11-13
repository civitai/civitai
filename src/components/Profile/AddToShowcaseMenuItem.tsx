import { Menu } from '@mantine/core';
import { IconHeart } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { showSuccessNotification } from '~/utils/notifications';

export function AddToShowcaseMenuItem({ entityType, entityId }: Props) {
  const utils = trpc.useContext();
  const addToShowcaseMutation = trpc.userProfile.addEntityToShowcase.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: `${entityType} has been added to showcase` });

      try {
        utils.userProfile.get.invalidate();
      } catch (error) {
        // Ignore, user must've not had the query loaded.
      }
    },
  });

  const onClick = async () => {
    await addToShowcaseMutation.mutateAsync({
      entityType,
      entityId,
    });
  };

  return (
    <Menu.Item
      icon={<IconHeart size={14} stroke={1.5} />}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      key="add-to-showcase"
    >
      Add to Showcase
    </Menu.Item>
  );
}

type Props = { entityType: 'Model' | 'Image'; entityId: number };
