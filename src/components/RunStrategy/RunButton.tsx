import { Button, ButtonProps, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons';
import { useAutomaticSDContext } from '~/hooks/useAutomaticSD';
import { useRoutedContext } from '~/routed-context/routed-context.provider';

type Props = { modelVersionId: number; generationParams?: string; label?: string } & ButtonProps;

export function RunButton({
  modelVersionId,
  generationParams,
  label = 'Run Model',
  ...props
}: Props) {
  const { openContext } = useRoutedContext();
  const { connected, run } = useAutomaticSDContext();

  const handleClick = connected
    ? () => run(modelVersionId, { generationParams })
    : () => openContext('runStrategy', { modelVersionId });

  return (
    <Tooltip label={label} withArrow position="bottom">
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
