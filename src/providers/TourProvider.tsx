import { useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useState } from 'react';
import Joyride, { Step, ACTIONS, Callback } from 'react-joyride';
import { IsClient } from '~/components/IsClient/IsClient';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

type TourState = {
  opened: boolean;
  step: number;
  toggleTour: VoidFunction;
};

const TourContext = createContext<TourState>({
  opened: false,
  step: 0,
  toggleTour: () => null,
});

export const useTourContext = () => {
  const context = useContext(TourContext);
  if (!context) {
    throw new Error('useTourContext must be used within a TourProvider');
  }
  return context;
};

export function TourProvider({ children }: { children: React.ReactNode }) {
  const currentUser = useCurrentUser();
  const searchParams = useSearchParams();
  const tourKey = searchParams.get('tour');
  const [state, setState] = useState<Omit<TourState, 'toggleTour'>>({
    opened: !!tourKey,
    step: 0,
  });

  const { data: userSettings, isLoading } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const toggleTour = () =>
    setState((current) => ({ ...current, opened: !current.opened, step: 0 }));

  const handleJoyrideCallback = useCallback<Callback>((data) => {
    console.log('Joyride callback', data);
  }, []);

  const steps = tourKey ? stepsMap[tourKey] || [] : [];
  const alreadyCompleted = tourKey
    ? userSettings?.tourSettings?.completed?.[tourKey] ?? false
    : false;

  return (
    <TourContext.Provider value={{ ...state, toggleTour }}>
      {children}
      <IsClient>
        <Joyride
          steps={steps}
          run={!isLoading && !alreadyCompleted}
          callback={handleJoyrideCallback}
        />
      </IsClient>
    </TourContext.Provider>
  );
}

const stepsMap: Record<string, Step[]> = {
  'tour-1': [
    {
      target: '[data-tour="1"]',
      content: 'This is the first step',
    },
    {
      target: '[data-tour="2"]',
      content: 'This is the second step',
    },
  ],
  'tour-2': [
    {
      target: '[data-tour="2"]',
      content: 'This is the second step',
    },
  ],
};
