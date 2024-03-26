import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useLocalStorage } from '@mantine/hooks';
import { PostHog, posthog } from 'posthog-js';
import { env } from '~/env/client.mjs';
import { isDev } from '~/env/other';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CivitaiSessionUser } from '~/components/CivitaiWrapped/CivitaiSessionProvider';

const PostHogCtx = createContext<PostHogContext>({} as PostHogContext);
type PostHogContext = {
  init: (user: CivitaiSessionUser | null) => PostHog | undefined;
};

export function usePostHog() {
  const ctx = useContext(PostHogCtx);
  const currentUser = useCurrentUser();
  if (!ctx) throw new Error('usePostHog can only be used inside PostHogCtx');
  return ctx.init(currentUser);
}

let identified = false;
let initialized = false;
const init = (user: CivitaiSessionUser | null) => {
  if (
    !env.NEXT_PUBLIC_POSTHOG_KEY ||
    !env.NEXT_PUBLIC_POSTHOG_HOST ||
    typeof window === 'undefined'
  )
    return;
  if (initialized) return posthog;

  posthog.init(env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://app.posthog.com',
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    loaded: () => {
      isDev && posthog.debug();
    },
  });
  if (!identified && user) {
    posthog.identify(user.id + '', {
      name: user.username,
      email: user.email,
    });
    identified = true;
  }
  initialized = true;
  return posthog;
};
export function CivitaiPosthogProvider({ children }: { children: ReactNode }) {
  return (
    <PostHogCtx.Provider
      value={{
        init,
      }}
    >
      {children}
    </PostHogCtx.Provider>
  );
}
