import { Text, useMantineTheme } from '@mantine/core';
import { reset } from 'linkifyjs';
import { useSearchParams } from 'next/navigation';
import Router from 'next/router';
import { createContext, useCallback, useContext, useState } from 'react';
import Joyride, {
  ACTIONS,
  Callback,
  EVENTS,
  Props as JoyrideProps,
  STATUS,
  Step,
} from 'react-joyride';
import { IsClient } from '~/components/IsClient/IsClient';
import { StepData, TourPopover } from '~/components/Tour/TourPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStorage } from '~/hooks/useStorage';
import { generationPanel } from '~/store/generation.store';
import { waitForElement } from '~/utils/html-helpers';
import { trpc } from '~/utils/trpc';

type StepWithData = Step & { data?: StepData };

type TourState = {
  running: boolean;
  forceRun: boolean;
  currentStep: number;
  runTour: (opts?: {
    key?: keyof typeof availableTours;
    step?: number;
    forceRun?: boolean;
  }) => void;
  closeTour: (opts?: { reset?: boolean }) => void;
  activeTour?: string | null;
  steps?: StepWithData[];
};

const TourContext = createContext<TourState>({
  running: false,
  forceRun: false,
  currentStep: 0,
  runTour: () => null,
  closeTour: () => null,
  steps: [],
});

export const useTourContext = () => {
  const context = useContext(TourContext);
  if (!context) throw new Error('useTourContext must be used within a TourProvider');

  return context;
};

const completeStatus: string[] = [STATUS.SKIPPED, STATUS.FINISHED];
const nextEvents: string[] = [EVENTS.STEP_AFTER, EVENTS.TARGET_NOT_FOUND];

export function TourProvider({ children, ...props }: Props) {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const searchParams = useSearchParams();
  const theme = useMantineTheme();
  const tourKey = searchParams.get('tour');

  const [state, setState] = useState<Omit<TourState, 'runTour' | 'closeTour' | 'helpers'>>({
    running: false,
    forceRun: false,
    activeTour: tourKey,
    currentStep: 0,
    steps: tourKey ? availableTours[tourKey] ?? [] : [],
  });

  const [completed = {}, setCompleted] = useStorage<{ [k: string]: boolean }>({
    key: 'completed-tours',
    type: 'localStorage',
    defaultValue: {},
  });

  const { data: userSettings, isInitialLoading } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const updateUserSettingsMutation = trpc.user.setSettings.useMutation({
    onSuccess: (result) => {
      queryUtils.user.getSettings.setData(undefined, (old) => ({ ...old, ...result }));
    },
  });

  const runTour: TourState['runTour'] = (opts) => {
    setState((old) => ({
      ...old,
      running: true,
      activeTour: opts?.key ?? old.activeTour,
      steps: opts?.key ? availableTours[opts.key] ?? [] : old.steps,
      forceRun: opts?.forceRun ?? old.forceRun,
      currentStep: opts?.step ?? old.currentStep,
    }));
  };

  const closeTour: TourState['closeTour'] = (args) => {
    setState((old) => ({
      ...old,
      running: false,
      currentStep: args?.reset ? 0 : old.currentStep,
    }));
  };

  const handleJoyrideCallback = useCallback<Callback>(
    async (data) => {
      const { status, type, action, index, step } = data;
      if (type === EVENTS.TOUR_END && completeStatus.includes(status) && state.activeTour) {
        updateUserSettingsMutation.mutate({
          completedTour: { [state.activeTour]: true },
        });
        // Need to explicit typecast here because ts is dumb
        setCompleted((old) => ({ ...old, [state.activeTour as string]: true }));
        closeTour({ reset: true });
        return;
      }

      if (nextEvents.includes(type)) {
        const isPrevAction = action === ACTIONS.PREV;
        const nextStepIndex = index + (isPrevAction ? -1 : 1);

        if (isPrevAction) await (step.data as StepData)?.onPrev?.();
        else await (step.data as StepData)?.onNext?.();

        if (step.data?.waitForElement) {
          closeTour();
          await waitForElement({ ...step.data.waitForElement }).catch(console.error);
        }

        runTour({ step: nextStepIndex });
      }
    },
    [setCompleted, state.activeTour, updateUserSettingsMutation]
  );

  const alreadyCompleted = state.activeTour
    ? (userSettings?.tourSettings?.completed?.[state.activeTour] ?? false) ||
      (completed[state.activeTour] ?? false)
    : false;

  console.log({
    running: state.running,
    forceRun: state.forceRun,
    activeTour: state.activeTour,
    steps: state.steps,
    alreadyCompleted,
    isInitialLoading,
    userSettings,
    completed,
    value: (!alreadyCompleted && !isInitialLoading) || state.forceRun,
  });

  return (
    <TourContext.Provider value={{ ...state, runTour, closeTour }}>
      {children}
      <IsClient>
        <Joyride
          steps={state.steps}
          stepIndex={state.currentStep}
          callback={handleJoyrideCallback}
          styles={{
            options: {
              zIndex: 10000,
              arrowColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
            },
          }}
          tooltipComponent={TourPopover}
          run={(state.running && !alreadyCompleted && !isInitialLoading) || state.forceRun}
          spotlightClicks
          showSkipButton
          continuous
          {...props}
        />
      </IsClient>
    </TourContext.Provider>
  );
}

type Props = Omit<JoyrideProps, 'callback' | 'steps'> & {
  children: React.ReactNode;
  steps?: StepWithData[];
};

const availableTours: Record<string, StepWithData[]> = {
  'content-generation': [
    {
      target: '[data-tour="gen:start"]',
      placement: 'auto',
      title: 'Getting Started with Content Generation',
      content:
        'Welcome to the content generation tool! This tour will guide you through the process.',
      locale: { next: "Let's go" },
      disableBeacon: true,
      disableOverlayClose: true,
    },
    {
      target: '[data-tour="gen:prompt"]',
      title: 'Start Here',
      content:
        'You can type a prompt here to generate an image. Try something simple, like "a blue robot", to get started.',
    },
    {
      target: '[data-tour="gen:prompt"]',
      title: 'Remix Content',
      content: (
        <div className="flex flex-col gap-2">
          <Text>
            Alternatively, you can remix existing images on the site. Click{' '}
            <Text weight={600} span>
              Next
            </Text>{' '}
            to learn more.
          </Text>
        </div>
      ),
      data: {
        onNext: () =>
          Router.push({
            pathname: '/collections/[collectionId]',
            query: { collectionId: 107, tour: 'content-generation' },
          }),
        waitForElement: { selector: '[data-tour="gen:remix"]', timeout: 30000 },
      },
    },
    {
      target: '[data-tour="gen:remix"]',
      title: 'Remix This Image',
      content: 'Click this button to remix an image and create something new',
      data: {
        onNext: () => generationPanel.open(),
        waitForElement: { selector: '[data-tour="gen:submit"]' },
      },
    },
    {
      target: '[data-tour="gen:submit"]',
      title: 'Submit Your Prompt',
      content: 'You can submit your prompt by clicking this button and see the magic happen!',
    },
    {
      target: '[data-tour="gen:reset"]',
      title: 'All Set!',
      content: 'You can view this tour at anytime by clicking this icon.',
      locale: { last: 'Done' },
    },
  ],

  'post-generation': [
    {
      target: '[data-tour="gen:queue"]',
      title: 'Your Generation Queue',
      content:
        'This is where your generated media is stored, along with all the generation details.',
      data: {
        onNext: () => generationPanel.setView('queue'),
      },
      disableBeacon: true,
    },
    {
      target: '[data-tour="gen:feed"]',
      title: 'Your Generation Feed',
      content: 'View all your generated media here in a single scrollable view.',
      data: {
        onNext: () => {
          generationPanel.setView('feed');
        },
        waitForElement: { selector: '[data-tour="gen:select"]' },
      },
    },
    {
      target: '[data-tour="gen:select"]',
      title: 'Selecting Content',
      content: (
        <Text>
          You can select images from both the{' '}
          <Text weight={600} span>
            Queue
          </Text>{' '}
          and the{' '}
          <Text weight={600} span>
            Feed
          </Text>{' '}
          to post them on the site. Posting lets you share your creations with the community and
          earn rewards like Buzz!
        </Text>
      ),
      data: {
        waitForElement: { selector: '[data-tour="gen:post"]' },
      },
    },
    {
      target: '[data-tour="gen:post"]',
      title: 'Posting Content',
      content: 'Click this button to post your selected content to the site.',
      data: {
        waitForElement: { selector: '[data-tour="post:title"]', timeout: 30000 },
      },
    },
    {
      target: '[data-tour="post:title"]',
      title: 'Add a Title',
      content:
        'Add a title to your post to give it some context. This step is optional but helps personalize your creation.',
      data: {
        onPrev: () => generationPanel.open(),
      },
    },
    {
      target: '[data-tour="post:tag"]',
      title: 'Add a Tag',
      content:
        'Tags help other users easily find relevant content. For example, if these are cat images, adding a "cat" tag would help categorize your content.',
    },
    {
      target: '[data-tour="post:description"]',
      title: 'Add a Description',
      content:
        'Descriptions provide additional details about your post, helping viewers understand your creation better.',
      data: {
        waitForElement: { selector: '[data-tour="post:rate-resource"]', timeout: 30000 },
      },
    },
    {
      target: '[data-tour="post:rate-resource"]',
      title: 'Rate the Resource',
      content:
        'Rate the resource you used to generate this content. This helps the creator improve the quality of their model.',
    },
    {
      target: '[data-tour="post:publish"]',
      title: 'Publish Your Post',
      content:
        'Once you are ready, click this button to publish your post to the site and your creations with the community!',
    },
  ],
};
