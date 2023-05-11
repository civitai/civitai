import { useRouter } from 'next/router';
import React, { MouseEventHandler, MouseEvent } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getLoginLink, LoginRedirectReason } from '~/utils/login-helpers';

export type Props = {
  children: React.ReactElement<{ onClick?: MouseEventHandler<HTMLElement> }>;
  reason: LoginRedirectReason;
  returnUrl?: string;
};

export function LoginRedirect({ children, reason, returnUrl }: Props) {
  const router = useRouter();
  const user = useCurrentUser();

  return !user
    ? React.cloneElement(children, {
        ...children.props,
        onClick: (e: MouseEvent<HTMLElement>) => {
          e.preventDefault();
          router.push(getLoginLink({ returnUrl: returnUrl ?? router.asPath, reason }));
        },
      })
    : children;
}

//TODO: Briant - consider using a hook to return a function that accepts an onclick callback
/*
  const loginRedirect = useLoginRedirect()
  const handleClick = () => {
    loginRedirect(() => {...do something})
  }
*/
