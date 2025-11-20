import type { ButtonProps } from '@mantine/core';
import { Button, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const RunStrategyModal = dynamic(() => import('~/components/Modals/RunStrategyModal'), {
  ssr: false,
});
const openRunStrategyModal = createDialogTrigger(RunStrategyModal);

export function RunButton({ modelVersionId, ...props }: { modelVersionId: number } & ButtonProps) {
  return (
    <Tooltip label="Run Model" withArrow position="top">
      <Button
        onClick={() => openRunStrategyModal({ props: { modelVersionId } })}
        color="green"
        {...props}
        style={{
          paddingLeft: 8,
          paddingRight: 8,
        }}
      >
        <IconPlayerPlay size={24} />
      </Button>
    </Tooltip>
  );
}
