import { Button, ButtonProps, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons';
import { useRoutedContext } from '~/routed-context/routed-context.provider';

export function RunButton({ modelVersionId, ...props }: { modelVersionId: number } & ButtonProps) {
  const { openContext } = useRoutedContext();

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
