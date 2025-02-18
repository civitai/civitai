import { useMantineTheme } from '@mantine/core';
import { usePathname, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import Joyride, {
  ACTIONS,
  Callback,
  EVENTS,
  LIFECYCLE,
  Props as JoyrideProps,
  STATUS,
} from 'react-joyride';
import { IsClient } from '~/components/IsClient/IsClient';
import { TourPopover } from '~/components/Tour/TourPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStorage } from '~/hooks/useStorage';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { TourSettingsSchema } from '~/server/schema/user.schema';
import { generationPanel } from '~/store/generation.store';
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
  activeTour?: TourKey | null;
  steps?: StepWithData[];
  returnUrl?: string;
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
  const path = usePathname();
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
    getInitialValueInEffect: false,
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
      const activeTour = opts?.key ?? state.activeTour;
      const forceRun = opts?.forceRun ?? state.forceRun;
      const currentTourData =
        userSettings?.tourSettings?.[activeTour ?? ''] ?? localTour[activeTour ?? ''];

      const alreadyCompleted = currentTourData?.completed ?? false;
      if (alreadyCompleted && !forceRun) return;

      setState((old) => ({
        ...old,
        running: true,
        activeTour: opts?.key ?? old.activeTour,
        steps: opts?.key ? tourSteps[opts.key] ?? [] : old.steps,
        forceRun: opts?.forceRun ?? old.forceRun,
        currentStep: opts?.step ?? old.currentStep,
      }));

      if (opts?.step != null && activeTour && !currentTourData?.completed) {
        const tour = { [activeTour]: { ...currentTourData, currentStep: opts.step } };
        if (currentUser) updateUserSettingsMutation.mutate({ tour });
        setLocalTour((old) => ({ ...old, ...tour }));
      }
    },
    [
      currentUser,
      localTour,
      state.activeTour,
      state.forceRun,
      userSettings?.tourSettings,
      setLocalTour,
      updateUserSettingsMutation,
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
        forceRun: opts?.reset ? false : old.forceRun,
      }));
    },
    [state.activeTour, state.currentStep, currentUser, setLocalTour, updateUserSettingsMutation]
  );

  const setSteps = (steps: TourState['steps']) => {
    setState((old) => ({ ...old, steps }));
  };

  const handleJoyrideCallback = useCallback<Callback>(
    async (data) => {
      const { status, type, action, index, step, lifecycle } = data;

      if (action === ACTIONS.UPDATE && lifecycle === LIFECYCLE.TOOLTIP) {
        const target = document.querySelector(step?.target as string);
        if (target && step.placement !== 'center')
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.dispatchEvent(new Event('resize'));
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
      } else if (type === EVENTS.STEP_BEFORE || type === EVENTS.TOUR_START) {
        await step.data?.onBeforeStart?.();
      }
    },
    [closeTour, runTour]
  );

  const alreadyCompleted = state.activeTour
    ? (userSettings?.tourSettings?.[state.activeTour]?.completed ?? false) ||
      (localTour[state.activeTour]?.completed ?? false)
    : false;

  useEffect(() => {
    if (isInitialLoading) return;

    const currentTourData = userSettings?.tourSettings?.[tourKey ?? ''] ?? localTour[tourKey ?? ''];
    if (currentTourData?.completed) return;

    // Set initial step based on user settings
    const currentStep = currentTourData?.currentStep ?? 0;
    setState((old) => ({ ...old, currentStep, returnUrl: path }));

    // handle initialization of the active tour
    switch (tourKey) {
      case 'content-generation':
        generationPanel.setView(currentStep > 6 ? 'feed' : 'generate');
        generationPanel.open();
        break;
      case 'remix-content-generation':
        generationPanel.setView(currentStep > 5 ? 'feed' : 'generate');
        generationPanel.open();
        break;
      default:
        break;
    }
  }, [isInitialLoading, tourKey]);

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
                arrowColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white,
              },
              spotlight: { border: `2px solid ${theme.colors.cyan[4]}` },
            }}
            locale={{
              nextLabelWithProgress: 'Next',
            }}
            floaterProps={{
              styles: {
                floater: {
                  position: 'absolute',
                  top: 0,
                },
              },
            }}
            tooltipComponent={TourPopover}
            run={(state.running && !alreadyCompleted && !isInitialLoading) || state.forceRun}
            disableScrollParentFix
            scrollToFirstStep
            disableScrolling
            showSkipButton
            showProgress
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
