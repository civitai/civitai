import { Session } from 'next-auth';
import { SessionUser } from 'next-auth';
import { signIn, useSession } from 'next-auth/react';
import { createContext, useContext, useMemo, useEffect } from 'react';
import { extendedSessionUser } from '~/utils/session-helpers';
import { onboardingSteps } from '~/components/Onboarding/onboarding.utils';
import { Flags } from '~/utils/flags';
import { dialogStore } from '~/components/Dialog/dialogStore';
import dynamic from 'next/dynamic';
const OnboardingModal = dynamic(() => import('~/components/Onboarding/OnboardingWizard'));

export type CivitaiSessionState = SessionUser & {
  refresh: () => Promise<Session | null>;
};
const CivitaiSessionContext = createContext<CivitaiSessionState | null>(null);
export const useCivitaiSessionContext = () => useContext(CivitaiSessionContext);

export function CivitaiSessionProvider({ children }: { children: React.ReactNode }) {
  const { data, update } = useSession();

  const value = useMemo(() => {
    if (!data?.user) return null;
    if (typeof window !== 'undefined') window.isAuthed = true;

    return {
      ...extendedSessionUser(data.user),
      refresh: update,
    };
  }, [data?.user, update]);

  useEffect(() => {
    if (data?.error === 'RefreshAccessTokenError') signIn();
  }, [data?.error]);

  useEffect(() => {
    const onboarding = value?.onboarding;
    if (onboarding !== undefined) {
      const shouldOnboard = !onboardingSteps.every((step) => Flags.hasFlag(onboarding, step));
      if (shouldOnboard) {
        dialogStore.trigger({
          component: OnboardingModal,
          id: 'onboarding',
          props: { onComplete: () => dialogStore.closeById('onboarding') },
        });
      }
    }
  }, [value?.onboarding]);

  return <CivitaiSessionContext.Provider value={value}>{children}</CivitaiSessionContext.Provider>;
}
