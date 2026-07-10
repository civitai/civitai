import { Tooltip, CloseButton, SegmentedControl } from '@mantine/core';
import type { Icon, IconProps } from '@tabler/icons-react';
import {
  IconArrowsDiagonal,
  IconBrush,
  IconGridDots,
  IconClockHour9,
  IconWifiOff,
  IconSettings,
} from '@tabler/icons-react';
import { Feed } from './Feed';
import { Queue } from './Queue';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import React, { useDeferredValue, useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { GeneratedRequestsProvider } from '~/components/ImageGeneration/GeneratedRequestsProvider';
import {
  SelectionProvider,
  generatedImageSelectStore,
} from '~/components/ImageGeneration/utils/generationImage.select';
import { SignalStatusNotification } from '~/components/Signals/SignalsProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { GenerationFormV2 } from '~/components/generation_v2';
import { ChallengeIndicator } from '~/components/Challenges/ChallengeIndicator';
import { PresetHeaderButton } from '~/components/generation_v2/preset/PresetHeaderButton';
import { useIsClient } from '~/providers/IsClientProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { getAllEcosystemVersionIdsForPrefetch } from '~/components/generation_v2/GenerationFormProvider';
import { ResourceDataProvider } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useRemixStore } from '~/store/remix.store';
import { WorkflowLookup } from '~/components/generation_v2/WorkflowLookup';

type GenerationPanelView = 'queue' | 'generate' | 'feed';

export default function GenerationTabs({ fullScreen }: { fullScreen?: boolean }) {
  // Pre-seed the ResourceDataProvider with ecosystem defaults + last-used models.
  // The provider keeps resources alive across tab switches and fires the initial
  // query before form IDs are added — giving the compatibility modal a cache hit.
  const initialIds = useMemo(() => getAllEcosystemVersionIdsForPrefetch(), []);
  return (
    <ResourceDataProvider initialIds={initialIds}>
      <GenerationTabsContent fullScreen={fullScreen} />
    </ResourceDataProvider>
  );
}

function GenerationTabsContent({ fullScreen }: { fullScreen?: boolean }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { runTour } = useTourContext();
  const remixOfId = useRemixStore((state) => state.data?.remixOfId);

  const isGeneratePage = router.pathname.startsWith('/generate');
  const isImageFeedSeparate = isGeneratePage && !fullScreen;

  const view = useGenerationPanelStore((state) => state.view);
  useEffect(() => {
    if (isImageFeedSeparate && view === 'generate') generationGraphPanel.setView('queue');
  }, [isImageFeedSeparate, view]);

  // Perf experiment: defer the generation-tab-switch remount to fix mobile INP.
  // Switching tabs swaps `View` to a DIFFERENT component, so React synchronously
  // unmounts the whole GenerationFormV2 tree and mounts Queue/Feed inside the tap's
  // onChange handler (~1s of processing_duration counted against INP). `useDeferredValue`
  // moves that heavy remount off the urgent path; the SegmentedControl highlight stays on
  // the live `view` for instant tap feedback. startTransition does NOT work here — zustand
  // external-store updates via useSyncExternalStore are always urgent and can't be deferred.
  // Flag OFF => contentView === view => behavior is byte-identical to today.
  // Measured via RUM `session_attr_exp_gen_tab_defer_view` mobile-INP A/B.
  const deferGenTabView = features.genTabDeferView;
  const deferredView = useDeferredValue(view);
  const contentView = deferGenTabView ? deferredView : view;

  const GenerationFormComponent = GenerationFormV2;

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

  const View = isImageFeedSeparate ? tabs.generate.Component : tabs[contentView].Component;
  // The Queue/Feed views share one workflow fetch + selection order via the provider.
  const showResults = !isImageFeedSeparate && contentView !== 'generate';
  const tabEntries = Object.entries(tabs).filter(([key]) =>
    isImageFeedSeparate ? key !== 'generate' : true
  );

  const isClient = useIsClient();

  if (!isClient) return null;

  return (
    <SelectionProvider store={generatedImageSelectStore}>
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
            {currentUser?.isModerator && <WorkflowLookup />}
            {features.challengePlatform && <ChallengeIndicator />}
            {features.generationPresets && <PresetHeaderButton />}
            {features.appTour && (
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
                  <>
                    <Tooltip
                      label={label}
                      position="bottom"
                      color="dark"
                      openDelay={200}
                      offset={10}
                    >
                      <div data-tour={`gen:${key}`} className="flex items-center justify-center">
                        <Icon size={16} />
                      </div>
                    </Tooltip>
                    {/* Accessible name for the icon-only radio (visually hidden) */}
                    <span className="sr-only">{label}</span>
                  </>
                ),
                value: key,
              }))}
              onChange={(key) => {
                generationGraphPanel.setView(key as GenerationPanelView);
              }}
              value={view}
            />
          )}
          <div className="flex flex-1 justify-end">
            {currentUser?.isModerator && (
              <Tooltip label="Generation config (mods)">
                <LegacyActionIcon
                  size="lg"
                  variant="transparent"
                  onClick={() => router.push('/moderator/generation-config')}
                >
                  <IconSettings size={20} />
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
              aria-label={isGeneratePage ? 'Go back' : 'Close generation panel'}
              onClick={isGeneratePage ? () => history.go(-1) : generationGraphPanel.close}
              size="lg"
              variant="transparent"
            />
          </div>
        </div>
        {contentView !== 'generate' && !isGeneratePage && <GeneratedImageActions />}
      </div>
      {showResults ? (
        <GeneratedRequestsProvider>
          <View />
        </GeneratedRequestsProvider>
      ) : (
        <View />
      )}
    </SelectionProvider>
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
