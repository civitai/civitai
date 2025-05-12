import { ChipProps, Chip } from '@mantine/core';
import classes from './FilterChip.module.scss';

export function FilterChip({ children, ...props }: ChipProps) {
   return (
    <Chip classNames={classes} size="sm" radius="xl" variant="filled" {...props}>
      {children}
    </Chip>
  );
}
 
