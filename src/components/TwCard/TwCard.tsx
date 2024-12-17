import React, { forwardRef } from 'react';
import clsx from 'clsx';
import { NextLink } from '~/components/NextLink/NextLink';

type TwCardProps = React.HTMLAttributes<HTMLElement> & {
  direction?: 'col' | 'row';
  href?: string;
};

export const TwCard = forwardRef<HTMLElement, TwCardProps>(
  ({ children, className, direction = 'col', href, ...props }, ref) => {
    return href ? (
      <NextLink
        ref={ref as any}
        href={href}
        className={clsx(
          'relative flex overflow-hidden rounded-md border-gray-3 bg-gray-0 shadow-gray-4 dark:border-dark-4 dark:bg-dark-6 dark:shadow-dark-8',
          direction === 'col' ? 'flex-col' : '',
          className
        )}
        {...props}
      >
        {children}
      </NextLink>
    ) : (
      <div
        ref={ref as any}
        className={clsx(
          'relative flex overflow-hidden rounded-md border-gray-3 bg-gray-0 shadow-gray-4 dark:border-dark-4 dark:bg-dark-6 dark:shadow-dark-8',
          direction === 'col' ? 'flex-col' : '',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

TwCard.displayName = 'TwCard';
