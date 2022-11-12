import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import React, { MouseEventHandler, MouseEvent } from 'react';
import { getLoginLink, LoginRedirectReason } from '~/utils/login-helpers';

type Props = {
  children: React.ReactElement<{ onClick?: MouseEventHandler<HTMLElement> }>;
  reason: LoginRedirectReason;
  returnUrl?: string;
};

export function LoginRedirect({ children, reason, returnUrl }: Props) {
  const router = useRouter();
  const { data: session } = useSession();
  return !session
    ? React.cloneElement(children, {
        ...children.props,
        onClick: (e: MouseEvent<HTMLElement>) => {
          e.preventDefault();
          router.push(getLoginLink({ returnUrl: returnUrl ?? router.asPath, reason }));
        },
      })
    : children;
}
