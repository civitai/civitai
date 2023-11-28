import { ActionIcon, Drawer, Title } from '@mantine/core';
import { IconArrowsMaximize } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';
import { containerQuery } from '~/utils/mantine-css-helpers';

export function GenerationDrawer() {
  const dialog = useDialogContext();
  // const router = useRouter();

  return (
    <Drawer {...dialog} size={800} position="left">
      {/* <ActionIcon
        radius="xl"
        size="lg"
        variant="filled"
        onClick={() => router.push('/generate')}
        sx={(theme) => ({
          position: 'absolute',
          top: theme.spacing.xs,
          right: -theme.spacing.xl - 17,
          backgroundColor: theme.white,
          '&:hover': {
            backgroundColor: theme.colors.gray[1],
          },

          [containerQuery.smallerThan(800 + theme.spacing.xl + 17)]: {
            left: theme.spacing.xs,
          },
        })}
      >
        <IconArrowsMaximize size={18} color="black" />
      </ActionIcon> */}
      <GenerationTabs />
    </Drawer>
  );
}
