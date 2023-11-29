import { createStyles, Badge, Card, Stack, Group, Button, StackProps } from '@mantine/core';
import { IconBrush, IconListDetails, IconSlideshow, TablerIconsProps } from '@tabler/icons-react';
import { Feed } from './Feed';
import { Queue } from './Queue';
import {
  useGetGenerationRequests,
  usePollGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { Generate } from '~/components/ImageGeneration/Generate';
import { useGenerationStore } from '~/store/generation.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useEffect } from 'react';

export default function GenerationTabs({
  tabs: tabsToInclude,
}: {
  tabs?: ('generate' | 'queue' | 'feed')[];
}) {
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
      render: () => <Feed {...result} />,
      label: <>Feed</>,
    },
  };

  const render = tabs[view].render;
  const tabEntries = Object.entries(tabs).filter(([key]) =>
    tabsToInclude ? tabsToInclude.includes(key as any) : true
  );

  useEffect(() => {
    if (tabsToInclude) {
      if (!tabsToInclude.includes(view)) setView(tabsToInclude[0]);
    }
  }, [tabsToInclude, view]); //eslint-disable-line

  return (
    <>
      <ScrollArea scrollRestore={{ key: view }}>{render()}</ScrollArea>

      {currentUser && tabEntries.length > 1 && (
        <Group spacing={0} grow className={classes.tabsList}>
          {tabEntries.map(([key, { Icon, label }], index) => (
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
    </>
  );
}

const useStyles = createStyles((theme) => ({
  tabsList: {
    borderTop: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
    }`,
  },
}));
