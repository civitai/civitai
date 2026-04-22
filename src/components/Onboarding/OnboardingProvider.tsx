import { createContext, useContext } from 'react';

type ContextState = { next: () => void; isReturningUser: boolean; isPreview?: boolean };

const OnboardingContext = createContext<ContextState>({
  next: () => undefined,
  isReturningUser: false,
  isPreview: false,
});

export const useOnboardingContext = () => useContext(OnboardingContext);

export function OnboardingProvider({
  next,
  isReturningUser,
  isPreview,
  children,
}: ContextState & { children: React.ReactNode }) {
  return (
    <OnboardingContext.Provider value={{ next, isReturningUser, isPreview }}>
      {children}
    </OnboardingContext.Provider>
  );
}
