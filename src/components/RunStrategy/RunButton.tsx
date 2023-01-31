import { Button, ButtonProps, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons';
import { openContext } from '~/providers/CustomModalsProvider';

export function RunButton({ modelVersionId, ...props }: { modelVersionId: number } & ButtonProps) {
  return (
    <Tooltip label="Run Model" withArrow position="top">
      <Button
        onClick={() => openContext('runStrategy', { modelVersionId })}
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
