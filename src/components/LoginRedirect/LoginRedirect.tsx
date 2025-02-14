import { useRouter } from 'next/router';
import React, { MouseEventHandler, MouseEvent } from 'react';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useTourContext } from '~/providers/TourProvider';
import { getLoginLink, LoginRedirectReason } from '~/utils/login-helpers';

export type HookProps = {
  reason: LoginRedirectReason;
  returnUrl?: string;
};
export function useLoginRedirect({ reason, returnUrl }: HookProps) {
  const router = useRouter();
  const user = useCurrentUser();

  const requireLogin = (fn?: () => void, overrides?: HookProps) => {
    if (!user) {
      router.push(
        getLoginLink({
          returnUrl: overrides?.returnUrl ?? returnUrl ?? router.asPath,
          reason: overrides?.reason ?? reason,
        })
      );
    } else {
      fn?.();
    }
  };

  return { requireLogin };
}

export type Props = HookProps & {
  children: React.ReactElement<{ onClick?: MouseEventHandler<HTMLElement> }>;
  beforeRedirect?: () => void;
};
export function LoginRedirect({ children, reason, returnUrl, beforeRedirect }: Props) {
  const router = useRouter();
  const user = useCurrentUser();
  const { running, closeTour, activeTour } = useTourContext();

  const url = new URL(returnUrl ?? router.asPath, env.NEXT_PUBLIC_BASE_URL);
  if (running && activeTour) url.searchParams.set('tour', activeTour);

  return !user
    ? React.cloneElement(children, {
        ...children.props,
        onClick: (e: MouseEvent<HTMLElement>) => {
          e.preventDefault();
          beforeRedirect?.();
          router.push(getLoginLink({ returnUrl: url.toString(), reason }));
          if (running) closeTour();
        },
      })
    : children;
}
