import {
  createStyles,
  Badge,
  Card,
  Stack,
  Group,
  Button,
  StackProps,
  Box,
  Tooltip,
  ActionIcon,
  CloseButton,
  SegmentedControl,
  Text,
} from '@mantine/core';
import {
  IconArrowsDiagonal,
  IconBrush,
  IconGridDots,
  IconListDetails,
  IconSlideshow,
  TablerIconsProps,
} from '@tabler/icons-react';
import { Feed } from './Feed';
import { Queue } from './Queue';
import {
  useGetGenerationRequests,
  usePollGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { generationPanel, useGenerationStore } from '~/store/generation.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useEffect } from 'react';
import { GenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationForm';
import { useRouter } from 'next/router';
import { IconClockHour9 } from '@tabler/icons-react';

export default function GenerationTabs({
  tabs: tabsToInclude,
  alwaysShowMaximize = true,
}: {
  tabs?: ('generate' | 'queue' | 'feed')[];
  alwaysShowMaximize?: boolean;
}) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const isGeneratePage = router.pathname.startsWith('/generate');

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
      label: 'Generate',
      render: () => (
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          <GenerationForm />
        </Box>
      ),
    },
    queue: {
      Icon: IconClockHour9,
      label: 'Queue',
      render: () => (
        <ScrollArea scrollRestore={{ key: 'queue' }} py={0}>
          <Queue {...result} />
        </ScrollArea>
      ),
    },
    feed: {
      Icon: IconGridDots,
      label: 'Feed',
      render: () => (
        <ScrollArea scrollRestore={{ key: 'feed' }} p="md">
          <Feed {...result} />
        </ScrollArea>
      ),
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
      <div className="flex justify-between items-center gap-2 p-3 w-full">
        <div className="flex-1">
          <Text className="w-full" lineClamp={1}>
            Folder
          </Text>
        </div>
        {currentUser && tabEntries.length > 1 && (
          <SegmentedControl
            className="flex-shrink-0"
            data={tabEntries.map(([key, { Icon }]) => ({ label: <Icon size={16} />, value: key }))}
            onChange={(key) => setView(key as any)}
          />
        )}
        <div className="flex flex-1 justify-end">
          {alwaysShowMaximize && !isGeneratePage && (
            <Tooltip label="Maximize">
              <ActionIcon size="lg" onClick={() => router.push('/generate')} variant="transparent">
                <IconArrowsDiagonal size={20} />
              </ActionIcon>
            </Tooltip>
          )}
          <CloseButton
            onClick={!isGeneratePage ? generationPanel.close : () => history.go(-1)}
            size="lg"
            variant="transparent"
          />
        </div>
      </div>

      {render()}
    </>
  );
}
