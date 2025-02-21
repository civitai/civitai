import { useRouter } from 'next/router';
import React, { MouseEventHandler, MouseEvent } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { getLoginLink, LoginRedirectReason } from '~/utils/login-helpers';
import { QS } from '~/utils/qs';

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

  // TODO.tour
  const url = returnUrl ?? router.asPath;
  if (running && activeTour) {
    // Add the active tour to the query string
    const [path, params] = url.split('?');
    const query = params ? QS.parse(params) : {};
    const queryString = QS.stringify({ ...query, tour: activeTour });

    returnUrl = `${path}?${queryString}`;
  }

  return !user
    ? React.cloneElement(children, {
        ...children.props,
        onClick: (e: MouseEvent<HTMLElement>) => {
          e.preventDefault();
          beforeRedirect?.();
          router.push(getLoginLink({ returnUrl, reason }));
          if (running) closeTour();
        },
      })
    : children;
}
