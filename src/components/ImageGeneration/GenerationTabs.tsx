import { Tooltip, ActionIcon, CloseButton, SegmentedControl, Text } from '@mantine/core';
import { IconArrowsDiagonal, IconBrush, IconGridDots, TablerIconsProps } from '@tabler/icons-react';
import { Feed } from './Feed';
import { Queue } from './Queue';
import { generationPanel, useGenerationStore } from '~/store/generation.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import React, { useEffect } from 'react';
import { GenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationForm';
import { useRouter } from 'next/router';
import { IconClockHour9 } from '@tabler/icons-react';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';

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

  type Tabs = Record<
    typeof view,
    {
      Icon: (props: TablerIconsProps) => JSX.Element;
      label: string;
      Component: React.FC;
    }
  >;

  const tabs: Tabs = {
    generate: {
      Icon: IconBrush,
      label: 'Generate',
      Component: GenerationForm,
    },
    queue: {
      Icon: IconClockHour9,
      label: 'Queue',
      Component: Queue,
    },
    feed: {
      Icon: IconGridDots,
      label: 'Feed',
      Component: Feed,
    },
  };

  const View = tabs[view].Component;
  const tabEntries = Object.entries(tabs).filter(([key]) =>
    tabsToInclude ? tabsToInclude.includes(key as any) : true
  );

  useEffect(() => {
    if (tabsToInclude) {
      if (!tabsToInclude.includes(view)) setView(tabsToInclude[0]);
    }
  }, [tabsToInclude, view]); //eslint-disable-line

  return (
    <GenerationProvider>
      <div className="flex flex-col gap-2 p-3 w-full">
        <div className="flex justify-between items-center gap-2 w-full">
          <div className="flex-1">
            {/* <Text className="w-full" lineClamp={1}>
              Folder
            </Text> */}
          </div>
          {currentUser && tabEntries.length > 1 && (
            <SegmentedControl
              className="flex-shrink-0"
              data={tabEntries.map(([key, { Icon }]) => ({
                label: <Icon size={16} />,
                value: key,
              }))}
              onChange={(key) => setView(key as any)}
              value={view}
            />
          )}
          <div className="flex flex-1 justify-end">
            {alwaysShowMaximize && !isGeneratePage && (
              <Tooltip label="Maximize">
                <ActionIcon
                  size="lg"
                  onClick={() => router.push('/generate')}
                  variant="transparent"
                >
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
        {view !== 'generate' && <GeneratedImageActions />}
      </div>
      <View />
    </GenerationProvider>
  );
}
