import { useRouter } from 'next/router';
import React, { MouseEventHandler, MouseEvent } from 'react';
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
};
export function LoginRedirect({ children, reason, returnUrl }: Props) {
  const router = useRouter();
  const user = useCurrentUser();
  const { running, closeTour } = useTourContext();

  return !user
    ? React.cloneElement(children, {
        ...children.props,
        onClick: (e: MouseEvent<HTMLElement>) => {
          e.preventDefault();
          router.push(getLoginLink({ returnUrl: returnUrl ?? router.asPath, reason }));
          if (running) closeTour();
        },
      })
    : children;
}
