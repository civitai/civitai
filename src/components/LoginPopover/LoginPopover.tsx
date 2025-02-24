import { cloneElement } from 'react';
import { requireLogin } from '~/components/Login/requireLogin';

export function LoginPopover({
  children,
  message = 'You must be logged in to perform this action',
}: {
  children: React.ReactElement;
  message?: React.ReactNode;
}) {
  const handleClick = (e: React.MouseEvent) => {
    requireLogin({
      uiEvent: e,
      message,
      cb: () => children.props.onClick?.(e),
    });
  };

  return cloneElement(children, { onClick: handleClick });
}
