import { Button, ButtonProps, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { openContext } from '~/providers/CustomModalsProvider';

export function RunButton({ modelVersionId, ...props }: { modelVersionId: number } & ButtonProps) {
  return (
    <Tooltip label="Run Model" withArrow position="top">
      <Button
        onClick={() => openContext('runStrategy', { modelVersionId })}
        color="green"
        {...props}
        sx={{
          paddingLeft: 8,
          paddingRight: 8,
          // width: 36,
        }}
        fullWidth
      >
        <IconPlayerPlay />
      </Button>
    </Tooltip>
  );
}
