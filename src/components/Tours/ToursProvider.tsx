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
import type { TourKey } from '~/components/Tours/tours';
import { tourSteps } from '~/components/Tours/tours';
import dynamic from 'next/dynamic';
import type { StoreHelpers } from 'react-joyride';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { useUserSettings } from '~/providers/UserSettingsProvider';

const LazyTours = dynamic(() => import('~/components/Tours/LazyTours'));

export type TourState = {
  running: boolean;
  forceRun: boolean;
  currentStep: number;
  activeTour?: TourKey | null;
  steps?: StepWithData[];
  returnUrl?: string;
};

type TourContextState = TourState & {
  runTour: (opts?: { key?: TourKey; step?: number; forceRun?: boolean }) => void;
  closeTour: (opts?: { reset?: boolean }) => void;
  setSteps: (steps: StepWithData[]) => void;
  completed?: boolean;
  run?: boolean;
  helpers?: StoreHelpers | null;
};

const TourContext = createContext<TourContextState>({
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
    activeTour: tourKey,
    currentStep: 0,
    steps: tourKey ? tourSteps[tourKey] ?? [] : [],
  }));
  const helpers = useRef<StoreHelpers | null>(null);

  const tourSettings = useUserSettings((x) => x.tourSettings);
  const setUserSettingsState = useUserSettings((x) => x.setState);

  const getCurrentTourData = useCallback(
    (key?: TourKey | null) => (key ? tourSettings?.[key] ?? localTour[key] : undefined),
    [tourSettings, localTour]
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
        activeTour,
        steps: opts?.key ? tourSteps[opts.key] ?? [] : old.steps,
        forceRun: opts?.forceRun ?? old.forceRun,
        currentStep: opts?.step ?? old.currentStep,
      }));

      if (opts?.step != null && activeTour && !alreadyCompleted) {
        const tourSettings = { [activeTour]: { ...currentTourData, currentStep: opts.step } };
        if (currentUser) setUserSettingsState({ tourSettings });
        setLocalTour((old) => ({ ...old, ...tourSettings }));
      }
    },
    [currentUser, getCurrentTourData, state.activeTour, state.forceRun, setLocalTour]
  );

  const closeTour = useCallback<TourContextState['closeTour']>(
    (opts) => {
      if (state.activeTour) {
        const currentTourData = getCurrentTourData(state.activeTour);
        const alreadyCompleted = currentTourData?.completed ?? false;

        if (!alreadyCompleted) {
          const tourSettings = {
            [state.activeTour]: { completed: opts?.reset ?? false, currentStep: state.currentStep },
          };
          if (currentUser) setUserSettingsState({ tourSettings });
          setLocalTour((old) => ({ ...old, ...tourSettings }));
        }
      }

      setState((old) => ({
        ...old,
        running: false,
        currentStep: opts?.reset ? 0 : old.currentStep,
        forceRun: opts?.reset ? false : old.forceRun,
      }));
    },
    [state.activeTour, state.currentStep, getCurrentTourData, currentUser, setLocalTour]
  );

  const setSteps = (steps: TourState['steps']) => {
    setState((old) => ({ ...old, steps }));
  };

  useEffect(() => {
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
  }, [tourKey]);

  const completed = currentTourData?.completed;
  const run = (state.running && !completed) || state.forceRun;

  return (
    <TourContext.Provider
      value={{ ...state, completed, run, runTour, closeTour, setSteps, helpers: helpers.current }}
    >
      {children}
      {features.appTour && state.activeTour && (
        <LazyTours getHelpers={(storeHelpers) => (helpers.current = storeHelpers)} />
      )}
    </TourContext.Provider>
  );
}
