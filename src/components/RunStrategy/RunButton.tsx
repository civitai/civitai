import { Button, ButtonProps, Text, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons';
import { useModalsContext } from '~/providers/CustomModalsProvider';

export function RunButton({ modelVersionId, ...props }: { modelVersionId: number } & ButtonProps) {
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
    <Tooltip label="Run Model" withArrow position="bottom">
      <Button
        onClick={handleClick}
        color="green"
        {...props}
        sx={{
          paddingLeft: 0,
          paddingRight: 0,
          width: 36,
        }}
      >
        <IconPlayerPlay />
      </Button>
    </Tooltip>
  );
}
