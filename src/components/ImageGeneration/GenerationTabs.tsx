import { Tooltip, CloseButton, SegmentedControl } from '@mantine/core';
import type { Icon, IconProps } from '@tabler/icons-react';
import {
  IconArrowsDiagonal,
  IconBrush,
  IconGridDots,
  IconClockHour9,
  IconWifiOff,
  IconToggleLeft,
  IconToggleRight,
} from '@tabler/icons-react';
import { useLocalStorage } from '@mantine/hooks';
import { Feed } from './Feed';
import { Queue } from './Queue';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import React, { useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { SignalStatusNotification } from '~/components/Signals/SignalsProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { GenerationFormV2 } from '~/components/generation_v2';
import { GenerationFormLegacy } from '~/components/ImageGeneration/GenerationForm/GenerationFormLegacy';
import { GeneratorToggleBanner } from '~/components/ImageGeneration/GeneratorToggle';
import { ChallengeIndicator } from '~/components/Challenges/ChallengeIndicator';
import { useIsClient } from '~/providers/IsClientProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { useLegacyGeneratorStore } from '~/store/legacy-generator.store';

type GenerationPanelView = 'queue' | 'generate' | 'feed';

export default function GenerationTabs({ fullScreen }: { fullScreen?: boolean }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const useLegacy = useLegacyGeneratorStore((state) => state.useLegacy);
  const hasExplicitPreference = useLegacyGeneratorStore((state) => state.hasExplicitPreference);
  const toggleGenerator = useLegacyGeneratorStore((state) => state.toggle);
  const [bannerDismissed] = useLocalStorage({
    key: 'dismiss-generator-toggle-banner',
    defaultValue: false,
  });

  const isGeneratePage = router.pathname.startsWith('/generate');
  const isImageFeedSeparate = isGeneratePage && !fullScreen;

  const view = useGenerationPanelStore((state) => state.view);
  const showToggle = hasExplicitPreference || bannerDismissed;
  useEffect(() => {
    if (isImageFeedSeparate && view === 'generate') generationGraphPanel.setView('queue');
  }, [isImageFeedSeparate, view]);

  // Select the appropriate form based on user preference
  const GenerationFormComponent = useLegacy ? GenerationFormLegacy : GenerationFormV2;

  const tabs = useMemo<Tabs>(
    () => ({
      generate: {
        Icon: IconBrush,
        label: 'Generate',
        Component: GenerationFormComponent,
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
    }),
    [GenerationFormComponent]
  );

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
            <ChallengeIndicator />
            {/* {features.appTour && (
              <HelpButton
                data-tour="gen:reset"
                tooltip="Need help? Start the tour!"
                onClick={async () => {
                  generationGraphPanel.setView('generate');
                  runTour({
                    key: remixOfId ? 'remix-content-generation' : 'content-generation',
                    step: 0,
                    forceRun: true,
                  });
                }}
              />
            )} */}
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
              onChange={(key) => generationGraphPanel.setView(key as GenerationPanelView)}
              value={view}
            />
          )}
          <div className="flex flex-1 justify-end">
            {showToggle && (
              <Tooltip
                label={useLegacy ? 'Switch to new generator' : 'Switch to classic generator'}
              >
                <LegacyActionIcon size="lg" onClick={toggleGenerator} variant="transparent">
                  {useLegacy ? <IconToggleLeft size={20} /> : <IconToggleRight size={20} />}
                </LegacyActionIcon>
              </Tooltip>
            )}
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
              onClick={isGeneratePage ? () => history.go(-1) : generationGraphPanel.close}
              size="lg"
              variant="transparent"
            />
          </div>
        </div>
        {view !== 'generate' && !isGeneratePage && <GeneratedImageActions />}
      </div>
      {view === 'generate' && <GeneratorToggleBanner />}
      <View />
    </>
  );
}

type Tabs = Record<
  GenerationPanelView,
  {
    Icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
    label: string;
    Component: React.FC;
  }
>;

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
