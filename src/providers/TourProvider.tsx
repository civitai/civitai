import { useMantineTheme } from '@mantine/core';
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
import { TourPopover } from '~/components/Tour/TourPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { generationPanel } from '~/store/generation.store';
import { EventEmitter } from '~/utils/eventEmitter';
import { trpc } from '~/utils/trpc';

type TourState = {
  opened: boolean;
  active: boolean;
  currentStep: number;
  toggleTour: (args?: Partial<Pick<TourState, 'currentStep'>>) => void;
  steps?: Step[];
  helpers?: StoreHelpers | null;
};

type TourEventEmitter = 'start' | 'end' | 'next' | 'prev';

const TourContext = createContext<TourState>({
  opened: false,
  active: false,
  currentStep: 0,
  toggleTour: () => null,
  steps: [],
});

const emitter = new EventEmitter<Record<TourEventEmitter, CallBackProps>>();

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
  const [state, setState] = useState<Omit<TourState, 'toggleTour' | 'helpers'>>({
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

  const toggleTour = (opts?: Partial<Pick<TourState, 'currentStep'>>) =>
    setState((current) => ({
      ...current,
      opened: !current.opened,
      currentStep: opts?.currentStep ?? current.currentStep,
    }));

  const handleJoyrideCallback = useCallback<Callback>(
    (data) => {
      const { status, type, action, index, size, step } = data;
      console.log(data);
      if (type === EVENTS.TOUR_END && completeStatus.includes(status) && tourKey) {
        // updateUserSettingsMutation.mutate({
        //   completedTour: { [tourKey]: true },
        // });
        emitter.emit('end', data);
        setState((current) => ({ ...current, opened: false, currentStep: 0 }));
      } else if (nextEvents.includes(type)) {
        const isPrevAction = action === ACTIONS.PREV;
        const nextStepIndex = index + (isPrevAction ? -1 : 1);

        if (index < size && (step.data?.onNext || step.data?.onPrev)) {
          setState((current) => ({ ...current, opened: false }));
        }

        if (isPrevAction) {
          emitter.emit('prev', data);
          setState((current) => ({ ...current, currentStep: nextStepIndex }));
        } else {
          emitter.emit('next', data);
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
    <TourContext.Provider value={{ ...state, toggleTour, helpers: tourHelpers.current }}>
      {children}
      <IsClient>
        <Joyride
          steps={steps}
          stepIndex={state.currentStep}
          run={(!isLoading && !alreadyCompleted) || state.opened}
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
          {...props}
        />
      </IsClient>
    </TourContext.Provider>
  );
}

type Props = Omit<JoyrideProps, 'callback' | 'steps'> & {
  children: React.ReactNode;
  steps?: Step[];
};

const stepsMap: Record<string, Step[]> = {
  'content-generation': [
    {
      target: '[data-tour="gen:start"]',
      title: 'Getting Start with Content Generation',
      content: `Ready to start creating content? Just click the "Create" button to begin!`,
      locale: { next: "Let's go" },
      data: {
        onNext: async () => {
          await generationPanel.open();
          await Router.push('/collections/151?tour=content-generation');
        },
        onPrev: async () => {
          generationPanel.close();
        },
      },
      disableBeacon: true,
      disableOverlayClose: true,
    },
    {
      target: '[data-tour="gen:panel]',
      title: 'Your Content Generation Panel',
      content:
        'This is the content generation panel. From here, you can choose to create images or videos and bring your ideas to life.',
      disableBeacon: true,
    },
    {
      target: '[data-tour="gen:prompt"]',
      title: 'Start Here',
      content:
        'You can type a prompt here to generate an image. Try something simple, like "a blue robot", to get started.',
    },
    {
      target: '[data-tour="gen:remix"]',
      title: 'Remix Content',
      content:
        'Alternatively, you can remix existing images on the site. Click Next to learn more.',
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
      locale: { next: 'Done' },
    },
  ],
  'tour-2': [
    {
      target: '[data-tour="2"]',
      content: 'This is the second step',
    },
  ],
};
