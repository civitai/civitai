import { Session, SessionUser } from 'next-auth';
import { signIn, useSession } from 'next-auth/react';
import dynamic from 'next/dynamic';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowsingModeContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { onboardingSteps } from '~/components/Onboarding/onboarding.utils';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';

const OnboardingModal = dynamic(() => import('~/components/Onboarding/OnboardingWizard'));

export function CivitaiSessionProvider({ children }: { children: React.ReactNode }) {
  const { data, update } = useSession();
  const { useStore } = useBrowsingModeContext();
  const browsingModeState = useStore((state) => state);

  const value = useMemo(() => {
    if (!data?.user) return null;

    return {
      ...data.user,
      isMember: data.user.tier != null,
      memberInBadState: data.user.memberInBadState,
      refresh: update,
      ...browsingModeState,
      blurNsfw: !Flags.intersection(browsingModeState.browsingLevel, nsfwBrowsingLevelsFlag)
        ? true
        : browsingModeState.blurNsfw,
    };
  }, [data?.expires, update, browsingModeState]); // eslint-disable-line

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

  return <Provider value={value}>{children}</Provider>;
}

export type CivitaiSessionUser = SessionUser & {
  isMember: boolean;
  refresh: () => Promise<Session | null>;
  showNsfw: boolean;
  blurNsfw: boolean;
  disableHidden?: boolean;
  browsingLevel: number;
};

// for reference: https://github.com/pacocoursey/state/blob/main/context.js
const CivitaiSessionContext = createContext<{
  state: CivitaiSessionUser | null;
  subscribe: (listener: (key: keyof CivitaiSessionUser, value: any) => void) => () => boolean;
} | null>(null);

export const Provider = ({
  children,
  value,
}: {
  children: React.ReactNode;
  value: CivitaiSessionUser | null;
}) => {
  const state = useRef(value);
  const listeners = useRef(new Set<(key: keyof CivitaiSessionUser, value: any) => void>());
  const [proxy, setProxy] = useState<CivitaiSessionUser | null>(value ? createProxy() : null);

  function createProxy() {
    return new Proxy<CivitaiSessionUser>({} as any, {
      get(_, key: keyof CivitaiSessionUser) {
        return state.current?.[key];
      },
    });
  }

  useEffect(() => {
    if (!value) return;
    if (!state.current) state.current = value;
    if (!proxy) setProxy(createProxy());
    for (const entries of Object.entries(value)) {
      const [key, value] = entries as [keyof CivitaiSessionUser, never];

      if (state.current && state.current[key] !== value) {
        state.current[key] = value;
        listeners.current.forEach((listener) => listener(key, value));
      }
    }
  }, [value]);

  const subscribe = (listener: (key: keyof CivitaiSessionUser, value: any) => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  };

  const context = useMemo(() => ({ state: proxy, subscribe }), [proxy]);
  return (
    <CivitaiSessionContext.Provider value={context}>{children}</CivitaiSessionContext.Provider>
  );
};

export const useCivitaiSessionContext = () => {
  const rerender = useState<Record<string, unknown>>()[1];
  const tracked = useRef<Record<string, boolean>>({});
  const context = useContext(CivitaiSessionContext);
  if (!context) throw new Error('missing CivitaiSessionContext');
  const { state, subscribe } = context;

  const proxy = useRef(
    new Proxy(
      {},
      {
        get(_, key: keyof CivitaiSessionUser) {
          tracked.current[key] = true;
          return state?.[key];
        },
      }
    )
  );

  useEffect(() => {
    const unsubscribe = subscribe((key) => {
      if (tracked.current[key]) {
        rerender({});
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return state ? (proxy.current as CivitaiSessionUser) : null;
};
