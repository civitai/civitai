import type { ButtonProps } from '@mantine/core';
import type { Icon, IconProps } from '@tabler/icons-react';
import { IconChevronDown } from '@tabler/icons-react';
import type { ForwardRefExoticComponent, MouseEventHandler, RefAttributes } from 'react';
import React, { forwardRef } from 'react';
import clsx from 'clsx';

export type FilterButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  ButtonProps & {
    icon?: ForwardRefExoticComponent<IconProps & React.RefAttributes<SVGSVGElement>>;
    active?: boolean;
    onClick?: MouseEventHandler<HTMLButtonElement>;
  };

// This is a temporary component. Since this is only used for dropdown filters, I plan on making a more reusable dropdown/popover component later. - Briant
export const FilterButton = forwardRef<HTMLButtonElement, FilterButtonProps>(
  ({ icon: Icon, children, className, active, size = 'sm', variant, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={clsx(
          'flex items-center gap-1 rounded-3xl border-none text-sm font-semibold text-gray-8 dark:text-white',
          size === 'sm' ? 'h-8 px-2' : 'h-9 pl-4 pr-3',
          !variant
            ? clsx(
                active ? 'bg-gray-2 dark:bg-dark-4' : 'bg-transparent',
                'hover:bg-gray-2 data-[expanded=true]:bg-gray-2',
                'dark:hover:bg-dark-5 dark:data-[expanded=true]:bg-dark-4'
              )
            : clsx(
                active ? 'bg-gray-2 dark:bg-gray-9' : '',
                'bg-gray-1 hover:bg-gray-2 data-[expanded=true]:bg-gray-2',
                'dark:bg-gray-8 dark:hover:bg-gray-9 dark:data-[expanded=true]:bg-gray-9'
              ),

          className
        )}
        {...props}
      >
        {Icon && <Icon size={16} />}
        <span suppressHydrationWarning>{children}</span>
        <IconChevronDown
          className={clsx(
            'ml-1 transition-transform',
            active ? 'rotate-180' : 'group-data-[expanded=true]:rotate-180'
          )}
          size={16}
        />
      </button>
    );
  }
);
FilterButton.displayName = 'FilterButton';

// export const FilterButton = forwardRef<HTMLButtonElement, FilterButtonProps>(
//   ({ icon: Icon, children, className, active, ...props }, ref) => {
//     return (
//       <Button
//         ref={ref}
//         rightSection={
//           <IconChevronDown
//             className={clsx(
//               'transition-transform',
//               active ? 'rotate-180' : 'group-data-[expanded=true]:rotate-180'
//             )}
//             size={16}
//           />
//         }
//         className={clsx(
//           'group h-8 rounded-3xl bg-transparent px-2',
//           'text-gray-8 hover:bg-gray-2 data-[expanded=true]:bg-gray-3',
//           'dark:text-white dark:hover:bg-dark-5 dark:data-[expanded=true]:bg-dark-4',
//           { ['bg-gray-3 dark:bg-dark-4']: active },
//           className
//         )}
//         {...props}
//       >
//         <div className="flex items-center gap-1" suppressHydrationWarning>
//           {Icon && <Icon size={16} />}
//           {children}
//         </div>
//       </Button>
//     );
//   }
// );
// FilterButton.displayName = 'FilterButton';
