import React, { forwardRef } from 'react';
import clsx from 'clsx';

type TwCardProps = React.HTMLAttributes<HTMLDivElement> & {
  direction?: 'col' | 'row';
};

export const TwCard = forwardRef<HTMLDivElement, TwCardProps>(
  ({ children, className, direction = 'col', ...props }, ref) => {
    return (
      <div
        ref={ref}
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
