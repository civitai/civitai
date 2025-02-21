import { cloneElement } from 'react';
import { requireLogin } from '~/components/Login/requireLogin';

export function LoginPopover({
  children,
  message,
}: {
  children: React.ReactElement;
  message?: React.ReactNode;
}) {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    e.nativeEvent.stopImmediatePropagation();
    requireLogin({
      message: message ?? 'You must be logged in to perform this action',
      cb: children.props.onClick?.(e),
    });
  };

  return cloneElement(children, { onClick: handleClick });
}
