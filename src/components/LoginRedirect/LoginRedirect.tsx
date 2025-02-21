import { useRouter } from 'next/router';
import React, { cloneElement } from 'react';
import { env } from '~/env/client';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { LoginRedirectReason } from '~/utils/login-helpers';
import { requireLogin } from '~/components/Login/requireLogin';

export type Props = {
  reason: LoginRedirectReason;
  returnUrl?: string;
  children: React.ReactElement;
};
export function LoginRedirect({ children, reason, returnUrl }: Props) {
  const router = useRouter();
  const { running, closeTour, activeTour } = useTourContext();

  const url = new URL(returnUrl ?? router.asPath, env.NEXT_PUBLIC_BASE_URL);
  if (running && activeTour) url.searchParams.set('tour', activeTour);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    e.nativeEvent.stopImmediatePropagation();
    if (running) closeTour();
    requireLogin({
      reason,
      cb: () => children.props.onClick?.(e),
      returnUrl: url.toString(),
    });
  }

  return cloneElement(children, { onClick: handleClick });
}
