import { useMantineTheme } from '@mantine/core';
import { useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useState } from 'react';
import Joyride, {
  ACTIONS,
  Callback,
  EVENTS,
  Props as JoyrideProps,
  LIFECYCLE,
  STATUS,
} from 'react-joyride';
import { IsClient } from '~/components/IsClient/IsClient';
import { TourPopover } from '~/components/Tour/TourPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStorage } from '~/hooks/useStorage';
import { StepData, StepWithData } from '~/types/tour';
import { TourKey, tourSteps } from '~/utils/tours';
import { trpc } from '~/utils/trpc';

type TourState = {
  running: boolean;
  forceRun: boolean;
  currentStep: number;
  runTour: (opts?: { key?: TourKey; step?: number; forceRun?: boolean }) => void;
  closeTour: (opts?: { reset?: boolean }) => void;
  setSteps: (steps: StepWithData[]) => void;
  activeTour?: string | null;
  steps?: StepWithData[];
};

const TourContext = createContext<TourState>({
  running: false,
  forceRun: false,
  currentStep: 0,
  runTour: () => null,
  closeTour: () => null,
  setSteps: () => null,
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
  const tourKey = searchParams.get('tour') as TourKey | null;

  const [state, setState] = useState<Omit<TourState, 'runTour' | 'closeTour' | 'setSteps'>>(() => ({
    running: false,
    forceRun: false,
    activeTour: tourKey,
    currentStep: 0,
    steps: tourKey ? tourSteps[tourKey] ?? [] : [],
  }));

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

  const runTour = useCallback<TourState['runTour']>((opts) => {
    setState((old) => ({
      ...old,
      running: true,
      activeTour: opts?.key ?? old.activeTour,
      steps: opts?.key ? tourSteps[opts.key] ?? [] : old.steps,
      forceRun: opts?.forceRun ?? old.forceRun,
      currentStep: opts?.step ?? old.currentStep,
    }));
  }, []);

  const closeTour = useCallback<TourState['closeTour']>(
    (opts) => {
      setState((old) => ({
        ...old,
        running: false,
        currentStep: opts?.reset ? 0 : old.currentStep,
      }));

      if (state.activeTour && opts?.reset) {
        updateUserSettingsMutation.mutate({
          completedTour: { [state.activeTour]: true },
        });
        // Need to explicitly typecast here because ts is dumb
        setCompleted((old) => ({ ...old, [state.activeTour as string]: true }));
      }
    },
    [setCompleted, state.activeTour, updateUserSettingsMutation]
  );

  const setSteps = (steps: TourState['steps']) => {
    setState((old) => ({ ...old, steps }));
  };

  const handleJoyrideCallback = useCallback<Callback>(
    async (data) => {
      const { status, type, action, index, step, lifecycle } = data;
      const target = document.querySelector(step.target as string);

      if (target && lifecycle === LIFECYCLE.TOOLTIP) window.dispatchEvent(new Event('resize'));
      if (target && step.placement === 'center')
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });

      if (action === ACTIONS.START && !target) {
        // If the target is not found at start, skip it
        setState((old) => ({ ...old, steps: old.steps?.filter((x) => x.target !== step.target) }));
      }

      if (type === EVENTS.TOUR_END && completeStatus.includes(status)) {
        closeTour({ reset: true });
        return;
      }

      if (nextEvents.includes(type)) {
        const isPrevAction = action === ACTIONS.PREV;
        const nextStepIndex = index + (isPrevAction ? -1 : 1);

        try {
          if (isPrevAction && step.data?.onPrev) {
            closeTour();
            await (step.data as StepData)?.onPrev?.();
          } else if (!isPrevAction && step.data?.onNext) {
            closeTour();
            await (step.data as StepData)?.onNext?.();
          }
        } catch {
          closeTour({ reset: true });
          return;
        }

        runTour({ step: nextStepIndex });
      }
    },
    [closeTour, runTour]
  );

  const alreadyCompleted = state.activeTour
    ? (userSettings?.tourSettings?.completed?.[state.activeTour] ?? false) ||
      (completed[state.activeTour] ?? false)
    : false;

  return (
    <TourContext.Provider value={{ ...state, runTour, closeTour, setSteps }}>
      {children}
      <IsClient>
        <Joyride
          key={state.activeTour}
          steps={state.steps}
          stepIndex={state.currentStep}
          callback={handleJoyrideCallback}
          styles={{
            options: {
              zIndex: 100000,
              arrowColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
            },
            spotlight: { border: `2px solid ${theme.colors.cyan[4]}` },
          }}
          tooltipComponent={TourPopover}
          run={(state.running && !alreadyCompleted && !isInitialLoading) || state.forceRun}
          scrollOffset={100}
          scrollToFirstStep
          disableScrollParentFix
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
