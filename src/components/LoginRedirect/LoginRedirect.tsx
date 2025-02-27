import { useRouter } from 'next/router';
import React, { cloneElement } from 'react';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { LoginRedirectReason } from '~/utils/login-helpers';
import { requireLogin } from '~/components/Login/requireLogin';
import { QS } from '~/utils/qs';

export type Props = {
  reason: LoginRedirectReason;
  returnUrl?: string;
  children: React.ReactElement;
};
export function LoginRedirect({ children, reason, returnUrl }: Props) {
  const router = useRouter();
  const { running, closeTour, activeTour } = useTourContext();

  let url = returnUrl ?? router.asPath;
  if (running && activeTour) {
    // Add the active tour to the query string
    const [path, params] = url.split('?');
    const query = params ? QS.parse(params) : {};
    const queryString = QS.stringify({ ...query, tour: activeTour });

    url = `${path}?${queryString}`;
  }

  function handleClick(e: React.MouseEvent) {
    if (running) closeTour();
    requireLogin({
      uiEvent: e,
      reason,
      cb: () => children.props.onClick?.(e),
      returnUrl: url,
    });
  }

  return cloneElement(children, { onClick: handleClick });
}
