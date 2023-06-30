import { Drawer, Tabs, createStyles } from '@mantine/core';
import { IconBrush, IconListDetails, IconSlideshow } from '@tabler/icons-react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Feed } from './Feed';
import { Generate } from './Generate';
import { Queue } from './Queue';
import { constants } from '~/server/common/constants';
import { useGenerationPanelControls } from '~/components/ImageGeneration/GenerationPanel';

export default function GenerationDrawer({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const { classes } = useStyles();
  const mobile = useIsMobile({ breakpoint: 'md' });

  const view = useGenerationPanelControls((state) => state.view);
  const setView = useGenerationPanelControls((state) => state.setView);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      size={mobile ? '90%' : 600}
      position={mobile ? 'bottom' : 'right'}
      withCloseButton={false}
      zIndex={constants.imageGeneration.drawerZIndex}
    >
      <Tabs
        value={view}
        onTabChange={setView}
        variant="pills"
        classNames={classes}
        keepMounted={false}
        inverted
      >
        <Tabs.Panel value="generate" pt={0}>
          <Generate onSuccess={() => setView('queue')} />
        </Tabs.Panel>
        <Tabs.Panel value="queue" py={0}>
          <Queue />
        </Tabs.Panel>
        <Tabs.Panel value="feed" py={0}>
          <Feed />
        </Tabs.Panel>

        <Tabs.List grow>
          <Tabs.Tab value="generate" icon={<IconBrush size={16} />} data-autofocus>
            Generate
          </Tabs.Tab>
          <Tabs.Tab value="queue" icon={<IconListDetails size={16} />}>
            Queue
          </Tabs.Tab>
          <Tabs.Tab value="feed" icon={<IconSlideshow size={16} />}>
            Feed
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
    </Drawer>
  );
}

const useStyles = createStyles((theme) => ({
  panel: {
    padding: theme.spacing.md,
    height: 'calc(100vh - 54px)',

    [theme.fn.smallerThan('md')]: {
      height: 'calc(90vh - 54px)',
    },
  },
  tabsList: {
    gap: 0,
    borderTop: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
    }`,
  },
  tab: {
    borderRadius: 0,
    flexDirection: 'column',
    gap: '4px',
  },
}));
