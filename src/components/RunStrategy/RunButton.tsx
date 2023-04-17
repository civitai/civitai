import { Button, ButtonProps, Tooltip } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons';
import { openContext } from '~/providers/CustomModalsProvider';
import { ModelApp } from '@prisma/client';
import { env } from '~/env/client.mjs';

export function RunButton({
  modelVersionId,
  app,
  ...props
}: { modelVersionId: number; app: ModelApp | null } & ButtonProps) {
  return (
    <Tooltip label="Run Model" withArrow position="top">
      <Button
        onClick={() => {
          if (app) window.open(`${env.NEXT_PUBLIC_APP_URL}/app/${app.id}`);
          else openContext('runStrategy', { modelVersionId });
        }}
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
