import { Text, useMantineTheme } from '@mantine/core';
import { reset } from 'linkifyjs';
import { useSearchParams } from 'next/navigation';
import Router from 'next/router';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Joyride, {
  ACTIONS,
  Callback,
  CallBackProps,
  EVENTS,
  Props as JoyrideProps,
  STATUS,
  Step,
  StoreHelpers,
} from 'react-joyride';
import { IsClient } from '~/components/IsClient/IsClient';
import { StepData, TourPopover } from '~/components/Tour/TourPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { generationPanel } from '~/store/generation.store';
import { trpc } from '~/utils/trpc';

type StepWithData = Step & { data?: StepData };

type TourState = {
  opened: boolean;
  active: boolean;
  currentStep: number;
  openTour: (args?: Partial<Pick<TourState, 'currentStep'>>) => void;
  closeTour: (args?: { reset?: boolean }) => void;
  steps?: StepWithData[];
  helpers?: StoreHelpers | null;
};

const TourContext = createContext<TourState>({
  opened: false,
  active: false,
  currentStep: 0,
  openTour: () => null,
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
  const [state, setState] = useState<Omit<TourState, 'openTour' | 'closeTour' | 'helpers'>>({
    opened: false,
    active: !!tourKey,
    currentStep: 0,
    steps: tourKey ? stepsMap[tourKey] ?? [] : [],
  });
  console.log({ state });
  const tourHelpers = useRef<StoreHelpers | null>(null);

  const { data: userSettings, isLoading } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const updateUserSettingsMutation = trpc.user.setSettings.useMutation({
    onSuccess: (result) => {
      queryUtils.user.getSettings.setData(undefined, (old) => ({ ...old, ...result }));
    },
  });

  const openTour = (opts?: Partial<Pick<TourState, 'currentStep'>>) =>
    setState((current) => ({
      ...current,
      opened: true,
      currentStep: opts?.currentStep ?? current.currentStep,
    }));

  const closeTour = (args?: { reset?: boolean }) =>
    setState((current) => ({
      ...current,
      opened: false,
      currentStep: args?.reset ? 0 : current.currentStep,
    }));

  const handleJoyrideCallback = useCallback<Callback>(
    (data) => {
      const { status, type, action, index, size, step } = data;
      console.log(data);
      if (type === EVENTS.TOUR_END && completeStatus.includes(status) && tourKey) {
        // updateUserSettingsMutation.mutate({
        //   completedTour: { [tourKey]: true },
        // });
        setState((current) => ({ ...current, opened: false, currentStep: 0 }));
      } else if (nextEvents.includes(type)) {
        const isPrevAction = action === ACTIONS.PREV;
        const nextStepIndex = index > 0 ? index + (isPrevAction ? -1 : 1) : 0;

        if (index < size && (step.data?.onNext || step.data?.onPrev)) {
          setState((current) => ({ ...current, opened: false }));
        }

        if (isPrevAction) {
          setState((current) => ({ ...current, currentStep: nextStepIndex }));
        } else {
          setState((current) => ({ ...current, currentStep: nextStepIndex }));
        }
      }
    },
    [tourKey, updateUserSettingsMutation]
  );

  const steps = tourKey ? stepsMap[tourKey] || [] : [];
  const alreadyCompleted = tourKey
    ? userSettings?.tourSettings?.completed?.[tourKey] ?? false
    : false;

  return (
    <TourContext.Provider value={{ ...state, openTour, closeTour, helpers: tourHelpers.current }}>
      {children}
      <IsClient>
        <Joyride
          steps={steps}
          stepIndex={state.currentStep}
          run={state.opened}
          callback={handleJoyrideCallback}
          styles={{
            options: {
              zIndex: 10000,
              arrowColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
            },
          }}
          getHelpers={(helpers) => (tourHelpers.current = helpers)}
          tooltipComponent={TourPopover}
          spotlightClicks
          continuous
          showSkipButton
          debug
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

const stepsMap: Record<string, StepWithData[]> = {
  'content-generation': [
    {
      target: '[data-tour="gen:start"]',
      title: 'Getting Started with Content Generation',
      content: `Ready to start creating content? Just click the "Create" button to begin!`,
      locale: { next: "Let's go" },
      data: {
        onNext: async ({ close }) => {
          close();
          await generationPanel.open();
        },
      },
      disableBeacon: true,
      disableOverlayClose: true,
    },
    {
      target: '[data-tour="gen:panel"]',
      title: 'Your Content Generation Panel',
      content:
        'This is the content generation panel. From here, you can choose to create images or videos and bring your ideas to life.',
      data: {
        onPrev: async ({ prev }) => {
          console.log('closing panel');
          generationPanel.close();
          prev();
        },
      },
      disableBeacon: true,
      disableOverlay: true,
      placement: 'center',
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
              <strong>Next</strong>
            </Text>{' '}
            to learn more.
          </Text>
        </div>
      ),
      data: {
        onNext: async ({ close }) => {
          close();
          await Router.push('/collections/1169354?tour=content-generation');
          // open();
        },
      },
    },
    {
      target: '[data-tour="gen:remix"]',
      title: 'Remix This Image',
      content: 'Click this button to remix an image and create something new',
    },
    {
      target: '[data-tour="gen:submit"]',
      content: 'You can submit your prompt by clicking this button and see the magic happen!',
    },
    {
      target: '[data-tour="gen:results"]',
      title: 'Your Generated Content',
      content: 'You can change between tabs to check your generated images and videos.',
    },
    {
      target: '[data-tour="gen:reset"]',
      content: 'You can view this tour at anytime by clicking this icon.',
      locale: { last: 'Done' },
    },
  ],
  'tour-2': [
    {
      target: '[data-tour="2"]',
      content: 'This is the second step',
    },
  ],
};
