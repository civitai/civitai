import { useRouter } from 'next/router';
import React, { cloneElement, forwardRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export const RequireMembership = forwardRef<HTMLElement, { children: React.ReactElement }>(
  ({ children }, ref) => {
    const currentUser = useCurrentUser();
    const router = useRouter();
    const { returnUrl } = router.query as { returnUrl?: string };

    function handleClick(e: React.MouseEvent) {
      if (!currentUser?.isPaidMember) {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        router.push({ pathname: '/pricing', query: { returnUrl: returnUrl ?? router.asPath } });
      } else children.props.onClick?.(e);
    }

    return cloneElement(children, {
      ref,
      onClick: handleClick,
    });
  }
);
RequireMembership.displayName = 'RequireMembership';
