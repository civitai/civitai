import React, { forwardRef } from 'react';
import clsx from 'clsx';

export const TwCard = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ children, className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={clsx(
          'relative flex flex-col overflow-hidden rounded-md border-gray-3 bg-gray-0 shadow-gray-4 dark:border-dark-4 dark:bg-dark-6 dark:shadow-dark-8',
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
