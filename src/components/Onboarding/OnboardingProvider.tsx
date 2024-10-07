import { createContext, useContext } from 'react';

type ContextState = { next: () => void; isReturningUser: boolean };

const OnboardingContext = createContext<ContextState>({
  next: () => undefined,
  isReturningUser: false,
});

export const useOnboardingContext = () => useContext(OnboardingContext);

export function OnboardingProvider({
  next,
  isReturningUser,
  children,
}: ContextState & { children: React.ReactNode }) {
  return (
    <OnboardingContext.Provider value={{ next, isReturningUser }}>
      {children}
    </OnboardingContext.Provider>
  );
}
