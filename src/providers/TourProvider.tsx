import { useMantineTheme } from '@mantine/core';
import { useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import Joyride, { ACTIONS, Callback, EVENTS, Props as JoyrideProps, STATUS } from 'react-joyride';
import { IsClient } from '~/components/IsClient/IsClient';
import { TourPopover } from '~/components/Tour/TourPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStorage } from '~/hooks/useStorage';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { TourSettingsSchema } from '~/server/schema/user.schema';
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
  const features = useFeatureFlags();
  const tourKey = searchParams.get('tour') as TourKey | null;

  const [state, setState] = useState<Omit<TourState, 'runTour' | 'closeTour' | 'setSteps'>>(() => ({
    running: false,
    forceRun: false,
    activeTour: tourKey,
    currentStep: 0,
    steps: tourKey ? tourSteps[tourKey] ?? [] : [],
  }));

  const [localTour = {}, setLocalTour] = useStorage<TourSettingsSchema>({
    key: 'tours',
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

  const runTour = useCallback<TourState['runTour']>(
    (opts) => {
      setState((old) => ({
        ...old,
        running: true,
        activeTour: opts?.key ?? old.activeTour,
        steps: opts?.key ? tourSteps[opts.key] ?? [] : old.steps,
        forceRun: opts?.forceRun ?? old.forceRun,
        currentStep: opts?.step ?? old.currentStep,
      }));

      const activeTour = opts?.key ?? state.activeTour;
      const currentTourData =
        userSettings?.tourSettings?.[activeTour ?? ''] ?? localTour[activeTour ?? ''];
      if (opts?.step != null && activeTour && !currentTourData?.completed) {
        const tour = { [activeTour]: { ...currentTourData, currentStep: opts.step } };
        if (currentUser) updateUserSettingsMutation.mutate({ tour });
        setLocalTour((old) => ({ ...old, ...tour }));
      }
    },
    [
      currentUser,
      localTour,
      setLocalTour,
      state.activeTour,
      updateUserSettingsMutation,
      userSettings?.tourSettings,
    ]
  );

  const closeTour = useCallback<TourState['closeTour']>(
    (opts) => {
      if (state.activeTour) {
        const tour = {
          [state.activeTour]: { completed: opts?.reset ?? false, currentStep: state.currentStep },
        };
        if (currentUser) updateUserSettingsMutation.mutate({ tour });
        setLocalTour((old) => ({ ...old, ...tour }));
      }

      setState((old) => ({
        ...old,
        running: false,
        currentStep: opts?.reset ? 0 : old.currentStep,
      }));
    },
    [setLocalTour, state.activeTour, state.currentStep, updateUserSettingsMutation, currentUser]
  );

  const setSteps = (steps: TourState['steps']) => {
    setState((old) => ({ ...old, steps }));
  };

  const handleJoyrideCallback = useCallback<Callback>(
    async (data) => {
      const { status, type, action, index, step } = data;

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

        setTimeout(() => {
          runTour({ step: nextStepIndex });
        }, 400);
      } else if (type === EVENTS.STEP_BEFORE || type === EVENTS.TOUR_START) {
        await step.data?.onBeforeStart?.();
      }
    },
    [closeTour, runTour]
  );

  useEffect(() => {
    if (isInitialLoading || state.running) return;
    // Update currentStep from userSettings
    setState((old) => ({
      ...old,
      currentStep:
        (userSettings?.tourSettings?.[old.activeTour ?? '']?.currentStep ?? 0) ||
        (localTour[old.activeTour ?? '']?.currentStep ?? 0),
    }));
  }, [localTour, userSettings?.tourSettings, isInitialLoading, state.running]);

  const alreadyCompleted = state.activeTour
    ? (userSettings?.tourSettings?.[state.activeTour]?.completed ?? false) ||
      (localTour[state.activeTour]?.completed ?? false)
    : false;

  useEffect(() => {
    if (alreadyCompleted && state.running) closeTour({ reset: true });
  }, [alreadyCompleted, closeTour, state.running]);

  return (
    <TourContext.Provider value={{ ...state, runTour, closeTour, setSteps }}>
      {children}
      {features.appTour && (
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
            // disableScrollParentFix
            scrollToFirstStep
            showSkipButton
            continuous
            {...props}
          />
        </IsClient>
      )}
    </TourContext.Provider>
  );
}

type Props = Omit<JoyrideProps, 'callback' | 'steps'> & {
  children: React.ReactNode;
  steps?: StepWithData[];
};
