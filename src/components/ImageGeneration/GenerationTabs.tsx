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
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ForwardRefExoticComponent, ReactNode } from 'react';
import React, { useDeferredValue, useMemo } from 'react';
import { useRouter } from 'next/router';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { GenerationResults } from '~/components/ImageGeneration/GenerationResults';
import {
  SelectionProvider,
  generatedImageSelectStore,
} from '~/components/ImageGeneration/utils/generationImage.select';
import { SignalStatusNotification } from '~/components/Signals/SignalsProvider';
import dynamic from 'next/dynamic';
import { ChallengeIndicator } from '~/components/Challenges/ChallengeIndicator';
import { PresetHeaderButton } from '~/components/generation_v2/preset/PresetHeaderButton';
import { useIsClient } from '~/providers/IsClientProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { GenerationPanelView } from '~/store/generation-panel.store';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { getAllEcosystemVersionIdsForPrefetch } from '~/components/Generation/form-helpers';
import { ResourceDataProvider } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useRemixStore } from '~/store/remix.store';
import { WorkflowLookup } from '~/components/generation_v2/WorkflowLookup';

// Each form lane pulls in its whole engine (~50 graph modules for form-graph,
// the data-graph tree for v1), so load only the lane the flag selects.
const FormGraphGenerator = dynamic(() =>
  import('~/components/form-graph/generation/FormGraphGenerator').then((m) => m.FormGraphGenerator)
);

// Exported so `tour-steps.test.ts` can check `gen:<key>` step targets against the tabs
// that actually render. The `data-tour` is built by template literal below, so no
// source file holds the whole string for the orphan guard to grep.
export const GENERATION_TAB_KEYS = [
  'generate',
  'queue',
  'feed',
] as const satisfies readonly GenerationPanelView[];

const TABS: Record<
  GenerationPanelView,
  { Icon: ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>; label: string }
> = {
  generate: { Icon: IconBrush, label: 'Generate' },
  queue: { Icon: IconClockHour9, label: 'Queue' },
  feed: { Icon: IconGridDots, label: 'Feed' },
};

type CloseProps = {
  onClose: () => void;
  closeLabel: string;
  /** Omit where the generator already fills the page. */
  onMaximize?: () => void;
};

/** The generator as one panel: a header whose tabs switch between the form and the results. */
export default function GenerationPanel(props: CloseProps) {
  const features = useFeatureFlags();
  const view = useGenerationPanelStore((state) => state.view);

  // Experiment (genTabDeferView): swapping form <-> results remounts the whole form tree
  // inside the tap handler, which dominated mobile INP; defer it so the tab highlight stays
  // instant. startTransition can't do this — zustand's useSyncExternalStore updates are
  // always urgent. RUM attr: `session_attr_exp_gen_tab_defer_view`.
  const deferredView = useDeferredValue(view);
  const contentView = features.genTabDeferView ? deferredView : view;

  return (
    <GenerationShell>
      <GenerationHeader tabs={GENERATION_TAB_KEYS} {...props}>
        {contentView !== 'generate' && <GeneratedImageActions />}
      </GenerationHeader>
      {contentView === 'generate' ? <GenerationForm /> : <GenerationResults view={contentView} />}
    </GenerationShell>
  );
}

/** Its queue/feed tabs drive the results the page renders beside it, not anything in this pane. */
export function GenerationFormPane(props: CloseProps) {
  return (
    <GenerationShell>
      <GenerationHeader tabs={['queue', 'feed']} {...props} />
      <GenerationForm />
    </GenerationShell>
  );
}

function GenerationShell({ children }: { children: ReactNode }) {
  // Pre-seed the ResourceDataProvider with ecosystem defaults + last-used models.
  // The provider keeps resources alive across tab switches and fires the initial
  // query before form IDs are added — giving the compatibility modal a cache hit.
  const initialIds = useMemo(() => getAllEcosystemVersionIdsForPrefetch(), []);
  const isClient = useIsClient();
  if (!isClient) return null;

  return (
    <ResourceDataProvider initialIds={initialIds}>
      <SelectionProvider store={generatedImageSelectStore}>
        <SignalStatusNotification icon={<IconWifiOff size={20} stroke={2} />} radius={0}>
          {(status) => (
            <p className="leading-4">
              <span className="font-medium">
                {status === 'reconnecting' ? 'Reconnecting' : 'Disconnected'}
              </span>
              : image generation results paused
            </p>
          )}
        </SignalStatusNotification>
        {children}
      </SelectionProvider>
    </ResourceDataProvider>
  );
}

function GenerationForm() {
  return <FormGraphGenerator />;
}

function GenerationHeader({
  tabs,
  onClose,
  closeLabel,
  onMaximize,
  children,
}: CloseProps & { tabs: readonly GenerationPanelView[]; children?: ReactNode }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { runTour } = useTourContext();
  const remixOfId = useRemixStore((state) => state.data?.remixOfId);
  const view = useGenerationPanelStore((state) => state.view);

  return (
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
                  trigger: 'help',
                });
              }}
            />
          )}
        </div>
        {currentUser && (
          <SegmentedControl
            className="shrink-0"
            style={{ overflow: 'visible' }}
            data-tour="gen:results"
            data={tabs.map((key) => {
              const { Icon, label } = TABS[key];
              return {
                label: (
                  <>
                    <Tooltip label={label} position="bottom" openDelay={200} offset={10}>
                      <div data-tour={`gen:${key}`} className="flex items-center justify-center">
                        <Icon size={16} />
                      </div>
                    </Tooltip>
                    {/* Accessible name for the icon-only radio (visually hidden) */}
                    <span className="sr-only">{label}</span>
                  </>
                ),
                value: key,
              };
            })}
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
          {onMaximize && (
            <Tooltip label="Maximize">
              <LegacyActionIcon size="lg" onClick={onMaximize} variant="transparent">
                <IconArrowsDiagonal size={20} />
              </LegacyActionIcon>
            </Tooltip>
          )}
          <CloseButton aria-label={closeLabel} onClick={onClose} size="lg" variant="transparent" />
        </div>
      </div>
      {children}
    </div>
  );
}
