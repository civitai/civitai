import { Tooltip, ActionIcon, CloseButton, SegmentedControl } from '@mantine/core';
import type { Icon, IconProps } from '@tabler/icons-react';
import {
  IconArrowsDiagonal,
  IconBrush,
  IconGridDots,
  IconClockHour9,
  IconWifiOff,
} from '@tabler/icons-react';
import { Feed } from './Feed';
import { Queue } from './Queue';
import type { GenerationPanelView } from '~/store/generation.store';
import { generationPanel, useGenerationStore, useRemixStore } from '~/store/generation.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import React, { useEffect } from 'react';
import { useRouter } from 'next/router';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { SignalStatusNotification } from '~/components/Signals/SignalsProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { GenerationForm } from '~/components/Generate/GenerationForm';
import { ChallengeIndicator } from '~/components/Challenges/ChallengeIndicator';
import { useIsClient } from '~/providers/IsClientProvider';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useGenerationPanelStore } from '~/store/generation-panel.store';

export default function GenerationTabs({ fullScreen }: { fullScreen?: boolean }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { runTour } = useTourContext();
  const features = useFeatureFlags();

  const isGeneratePage = router.pathname.startsWith('/generate');
  const isImageFeedSeparate = isGeneratePage && !fullScreen;

  const view = useGenerationPanelStore((state) => state.view);
  const setView = useGenerationStore((state) => state.setView);
  const remixOfId = useRemixStore((state) => state.remixOfId);
  useEffect(() => {
    if (isImageFeedSeparate && view === 'generate') setView('queue');
  }, [isImageFeedSeparate, view]);

  const View = isImageFeedSeparate ? tabs.generate.Component : tabs[view].Component;
  const tabEntries = Object.entries(tabs).filter(([key]) =>
    isImageFeedSeparate ? key !== 'generate' : true
  );

  const isClient = useIsClient();

  if (!isClient) return null;

  return (
    <>
      <SignalStatusNotification
        icon={<IconWifiOff size={20} stroke={2} />}
        // title={(status) => `Connection status: ${status}`}
        radius={0}
      >
        {(status) => (
          <p className="leading-4">
            <span className="font-medium">
              {status === 'reconnecting' ? 'Reconnecting' : 'Disconnected'}
            </span>
            : image generation results paused
          </p>
        )}
      </SignalStatusNotification>
      <div className="flex w-full flex-col gap-2 p-3">
        <div className="flex w-full items-center justify-between gap-2">
          <div className="relative flex flex-1 flex-nowrap items-center gap-2">
            {features.challengePlatform && <ChallengeIndicator />}
            {features.appTour && (
              <HelpButton
                data-tour="gen:reset"
                tooltip="Need help? Start the tour!"
                onClick={async () => {
                  generationPanel.setView('generate');
                  runTour({
                    key: remixOfId ? 'remix-content-generation' : 'content-generation',
                    step: 0,
                    forceRun: true,
                  });
                }}
              />
            )}
          </div>
          {currentUser && tabEntries.length > 1 && (
            <SegmentedControl
              // TODO.briant: this fixes the issue with rendering the SegmentedControl
              key={tabEntries.map(([, item]) => item.label).join('-')}
              className="shrink-0"
              style={{ overflow: 'visible' }}
              data-tour="gen:results"
              data={tabEntries.map(([key, { Icon, label }]) => ({
                label: (
                  <Tooltip label={label} position="bottom" color="dark" openDelay={200} offset={10}>
                    <div data-tour={`gen:${key}`} className="flex items-center justify-center">
                      <Icon size={16} />
                    </div>
                  </Tooltip>
                ),
                value: key,
              }))}
              onChange={(key) => setView(key as GenerationPanelView)}
              value={view}
            />
          )}
          <div className="flex flex-1 justify-end">
            {!fullScreen && !isGeneratePage && (
              <Tooltip label="Maximize">
                <LegacyActionIcon
                  size="lg"
                  onClick={() => router.push('/generate')}
                  variant="transparent"
                >
                  <IconArrowsDiagonal size={20} />
                </LegacyActionIcon>
              </Tooltip>
            )}
            <CloseButton
              onClick={isGeneratePage ? () => history.go(-1) : generationPanel.close}
              size="lg"
              variant="transparent"
            />
          </div>
        </div>
        {view !== 'generate' && !isGeneratePage && <GeneratedImageActions />}
      </div>
      <View />
    </>
  );
}

type Tabs = Record<
  GenerationPanelView,
  {
    Icon: ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>;
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
    Component: ScrollableQueue,
  },
  feed: {
    Icon: IconGridDots,
    label: 'Feed',
    Component: ScrollableFeed,
  },
};

function ScrollableQueue() {
  return (
    <ScrollArea scrollRestore={{ key: 'queue' }}>
      <Queue />
    </ScrollArea>
  );
}

function ScrollableFeed() {
  return (
    <ScrollArea scrollRestore={{ key: 'feed' }}>
      <Feed />
    </ScrollArea>
  );
}
