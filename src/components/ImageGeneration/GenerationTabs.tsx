import { createStyles, Badge, Card, Stack, Group, Button, StackProps } from '@mantine/core';
import { IconBrush, IconListDetails, IconSlideshow, TablerIconsProps } from '@tabler/icons-react';
import { Feed, FloatingFeedActions } from './Feed';
import { Queue } from './Queue';
import {
  useGetGenerationRequests,
  usePollGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { Generate } from '~/components/ImageGeneration/Generate';
import { useGenerationStore } from '~/store/generation.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export default function GenerationTabs({ wrapperProps }: { wrapperProps?: StackProps }) {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();

  const view = useGenerationStore((state) => state.view);
  const setView = useGenerationStore((state) => state.setView);

  const result = useGetGenerationRequests();
  const pendingProcessingCount = usePollGenerationRequests(result.requests);

  type Tabs = Record<
    typeof view,
    {
      Icon: (props: TablerIconsProps) => JSX.Element;
      header?: () => JSX.Element;
      render: () => JSX.Element;
      label: React.ReactNode;
    }
  >;

  const tabs: Tabs = {
    generate: {
      Icon: IconBrush,
      render: () => <Generate />,
      label: <>Generate</>,
    },
    queue: {
      Icon: IconListDetails,
      render: () => <Queue {...result} />,
      label: (
        <Group spacing={4}>
          Queue{' '}
          {pendingProcessingCount > 0 && (
            <Badge color="red" variant="filled" size="xs">
              {pendingProcessingCount}
            </Badge>
          )}
        </Group>
      ),
    },
    feed: {
      Icon: IconSlideshow,
      header: () => (
        <FloatingFeedActions images={result.images}>
          {({ selected, render }) => (selected.length ? <Card radius={0}>{render}</Card> : <></>)}
        </FloatingFeedActions>
      ),
      render: () => (
        <Stack spacing={0} p="md">
          <Feed {...result} />
        </Stack>
      ),
      label: <>Feed</>,
    },
  };

  const header = tabs[view].header;
  const render = tabs[view].render;

  return (
    <Stack h="100%" style={{ overflow: 'hidden' }} spacing={0} {...wrapperProps}>
      {header && <div>{header()}</div>}
      <div style={{ flexGrow: 1, overflowY: 'auto' }}>{render()}</div>

      {currentUser && (
        <Group spacing={0} grow className={classes.tabsList}>
          {Object.entries(tabs).map(([key, { Icon, label }], index) => (
            <Button
              key={index}
              data-autofocus={index === 0}
              onClick={() => setView(key as any)}
              variant={key === view ? 'filled' : 'default'}
              radius={0}
              sx={{ height: 54 }}
            >
              <Stack align="center" spacing={4}>
                <Icon size={16} />
                {label}
              </Stack>
            </Button>
          ))}
        </Group>
      )}
    </Stack>
  );
}

const useStyles = createStyles((theme) => ({
  tabsList: {
    borderTop: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
    }`,
  },
}));
