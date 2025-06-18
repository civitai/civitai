import type { TypographyStylesProviderProps } from '@mantine/core';
import { TypographyStylesProvider } from '@mantine/core';
import classes from './TypographyStylesWrapper.module.scss';

export function TypographyStylesWrapper({
  children,
  classNames,
  ...props
}: TypographyStylesProviderProps) {
  return (
    <TypographyStylesProvider {...props} classNames={classes}>
      {children}
    </TypographyStylesProvider>
  );
}
