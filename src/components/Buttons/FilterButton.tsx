import { ButtonProps, Button } from '@mantine/core';
import { Icon, IconChevronDown, IconProps } from '@tabler/icons-react';
import React, {
  ForwardRefExoticComponent,
  MouseEventHandler,
  RefAttributes,
  forwardRef,
} from 'react';
import clsx from 'clsx';

type FilterButtonProps = ButtonProps & {
  icon?: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  active?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
};

export const FilterButton = forwardRef<HTMLButtonElement, FilterButtonProps>(
  ({ icon: Icon, children, className, active, ...props }, ref) => {
    return (
      <Button
        ref={ref}
        rightIcon={
          <IconChevronDown
            className="transition-transform group-data-[expanded=true]:rotate-180"
            size={16}
          />
        }
        className={clsx(
          'group h-8 rounded-3xl bg-transparent px-2',
          'text-gray-8 hover:bg-gray-2 data-[expanded=true]:bg-gray-3',
          'dark:text-white dark:hover:bg-dark-5 dark:data-[expanded=true]:bg-dark-4',
          className
        )}
        data-expanded={active}
        {...props}
      >
        <div className="flex items-center gap-1" suppressHydrationWarning>
          {Icon && <Icon size={16} />}
          {children}
        </div>
      </Button>
    );
  }
);
FilterButton.displayName = 'FilterButton';
