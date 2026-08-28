import { usePathname, useSearchParams } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useMemo,
  useRef,
} from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStorage } from '~/hooks/useStorage';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { TourSettingsSchema } from '~/server/schema/user.schema';
import type { StepWithData } from '~/types/tour';
import type { TourEndReason, TourTrigger } from '~/utils/faro/tour';
import type { TourKey } from '~/components/Tours/tours';
import { tourSteps } from '~/components/Tours/tours';
import { trpc } from '~/utils/trpc';
import dynamic from 'next/dynamic';
import type { StoreHelpers } from 'react-joyride';
import { useMutateUserSettings } from '~/components/UserSettings/hooks';
import { useGenerationPanelStore } from '~/store/generation-panel.store';

const LazyTours = dynamic(() => import('~/components/Tours/LazyTours'));

export type TourState = {
  running: boolean;
  forceRun: boolean;
  paused: boolean;
  trigger: TourTrigger;
  currentStep: number;
  activeTour?: TourKey | null;
  steps?: StepWithData[];
  returnUrl?: string;
};

type TourContextState = TourState & {
  runTour: (opts?: {
    key?: TourKey;
    step?: number;
    forceRun?: boolean;
    trigger?: TourTrigger;
  }) => void;
  pauseTour: () => void;
  closeTour: (opts: { reason: TourEndReason }) => void;
  setSteps: (steps: StepWithData[]) => void;
  completed?: boolean;
  run?: boolean;
  helpers?: StoreHelpers | null;
};

const TourContext = createContext<TourContextState>({
  running: false,
  forceRun: false,
  paused: false,
  trigger: 'auto',
  currentStep: 0,
  runTour: () => null,
  pauseTour: () => null,
  closeTour: () => null,
  setSteps: () => null,
  steps: [],
});

export const useTourContext = () => {
  const context = useContext(TourContext);
  if (!context) throw new Error('useTourContext must be used within a TourProvider');

  return context;
};

export function ToursProvider({ children }: { children: React.ReactNode }) {
  const currentUser = useCurrentUser();
  const searchParams = useSearchParams();
  const path = usePathname();
  const features = useFeatureFlags();
  const tourKey = searchParams.get('tour') as TourKey | null;

  const [localTour = {}, setLocalTour] = useStorage<TourSettingsSchema>({
    key: 'tours',
    type: 'localStorage',
    defaultValue: {},
    getInitialValueInEffect: false,
  });

  const [state, setState] = useState<TourState>(() => ({
    running: false,
    forceRun: false,
    paused: false,
    trigger: tourKey ? 'url' : 'auto',
    activeTour: tourKey,
    currentStep: 0,
    steps: tourKey ? tourSteps[tourKey] ?? [] : [],
  }));
  const helpers = useRef<StoreHelpers | null>(null);

  const { data: userSettings, isInitialLoading } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const updateUserSettingsMutation = useMutateUserSettings();

  const getCurrentTourData = useCallback(
    (key?: TourKey | null) =>
      key ? userSettings?.tourSettings?.[key] ?? localTour[key] : undefined,
    [userSettings?.tourSettings, localTour]
  );

  const currentTourData = useMemo(
    () => getCurrentTourData(state.activeTour),
    [getCurrentTourData, state.activeTour]
  );

  const runTour = useCallback<TourContextState['runTour']>(
    (opts) => {
      const activeTour = opts?.key ?? state.activeTour;
      const forceRun = opts?.forceRun ?? state.forceRun;
      const currentTourData = getCurrentTourData(activeTour);
      const alreadyCompleted = currentTourData?.completed ?? false;
      if (alreadyCompleted && !forceRun) return;

      setState((old) => ({
        ...old,
        running: true,
        paused: false,
        activeTour,
        steps: opts?.key ? tourSteps[opts.key] ?? [] : old.steps,
        forceRun: opts?.forceRun ?? old.forceRun,
        trigger: opts?.trigger ?? old.trigger,
        currentStep: opts?.step ?? old.currentStep,
      }));

      if (opts?.step != null && activeTour && !alreadyCompleted) {
        const tourSettings = { [activeTour]: { ...currentTourData, currentStep: opts.step } };
        if (currentUser) updateUserSettingsMutation.mutate({ tourSettings });
        setLocalTour((old) => ({ ...old, ...tourSettings }));
      }
    },
    [
      currentUser,
      getCurrentTourData,
      state.activeTour,
      state.forceRun,
      setLocalTour,
      updateUserSettingsMutation,
    ]
  );

  const pauseTour = useCallback<TourContextState['pauseTour']>(() => {
    if (state.activeTour && !getCurrentTourData(state.activeTour)?.completed) {
      const tourSettings = {
        [state.activeTour]: { completed: false, currentStep: state.currentStep },
      };
      if (currentUser) updateUserSettingsMutation.mutate({ tourSettings });
      setLocalTour((old) => ({ ...old, ...tourSettings }));
    }

    setState((old) => ({ ...old, running: false, paused: true }));
  }, [
    state.activeTour,
    state.currentStep,
    getCurrentTourData,
    currentUser,
    updateUserSettingsMutation,
    setLocalTour,
  ]);

  const closeTour = useCallback<TourContextState['closeTour']>(
    ({ reason }) => {
      if (state.activeTour && !getCurrentTourData(state.activeTour)?.completed) {
        const tourSettings = {
          [state.activeTour]: { completed: true, currentStep: state.currentStep, reason },
        };
        if (currentUser) updateUserSettingsMutation.mutate({ tourSettings });
        setLocalTour((old) => ({ ...old, ...tourSettings }));
      }

      setState((old) => ({ ...old, running: false, paused: false, currentStep: 0, forceRun: false }));
    },
    [
      state.activeTour,
      state.currentStep,
      getCurrentTourData,
      currentUser,
      updateUserSettingsMutation,
      setLocalTour,
    ]
  );

  const setSteps = (steps: TourState['steps']) => {
    setState((old) => ({ ...old, steps }));
  };

  useEffect(() => {
    if (isInitialLoading) return;

    // Set initial step based on user settings
    const currentStep = currentTourData?.currentStep ?? 0;
    setState((old) => ({ ...old, currentStep, returnUrl: path }));

    // handle initialization of the active tour
    switch (tourKey) {
      case 'content-generation':
      case 'remix-content-generation':
        useGenerationPanelStore.setState({ opened: true, view: 'generate' });
        break;
      default:
        break;
    }
  }, [isInitialLoading, tourKey]);

  const completed = currentTourData?.completed;
  const run =
    !state.paused && ((state.running && !completed) || state.forceRun) && !isInitialLoading;

  return (
    <TourContext.Provider
      value={{
        ...state,
        completed,
        run,
        runTour,
        pauseTour,
        closeTour,
        setSteps,
        helpers: helpers.current,
      }}
    >
      {children}
      {features.appTour && state.activeTour && (
        <LazyTours getHelpers={(storeHelpers) => (helpers.current = storeHelpers)} />
      )}
    </TourContext.Provider>
  );
}
