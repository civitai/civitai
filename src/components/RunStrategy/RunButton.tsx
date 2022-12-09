import { Button, Text } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons';
import { useModalsContext } from '~/providers/CustomModalsProvider';

export function RunButton({ modelVersionId }: { modelVersionId: number }) {
  const { openModal } = useModalsContext();

  const handleClick = () =>
    openModal<{ modelVersionId: number }>({
      modal: 'runStrategy',
      title: <Text weight={700}>Generate images using this model now</Text>,
      size: 600,
      innerProps: {
        modelVersionId,
      },
    });

  return (
    <Button rightIcon={<IconPlayerPlay size={16} />} onClick={handleClick} px="sm">
      Run
    </Button>
  );
}
