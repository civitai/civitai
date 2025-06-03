// @ts-nocheck
import React, { forwardRef } from 'react';
import type { DefaultProps, GridProps, MantineSpacing } from '@mantine/core';
import { Grid, useProps } from '@mantine/core';

import { ContainerCol } from './ContainerCol';
import { ContainerGridProvider } from './ContainerGrid.context';
import { Box } from '@mantine/core';
import classes from './ContainerGrid.module.scss';
import clsx from 'clsx';
import { breakpoints } from '~/utils/tailwind';

export interface ContainerGridProps extends DefaultProps, React.ComponentPropsWithRef<'div'> {
  /** <Col /> components only */
  children: React.ReactNode;

  /** Spacing between columns, key of theme.spacing or number for value in px  */
  gutter?: MantineSpacing;

  /** Gutter when screen size is larger than theme.breakpoints.xs */
  gutterXs?: MantineSpacing;

  /** Gutter when screen size is larger than theme.breakpoints.sm */
  gutterSm?: MantineSpacing;

  /** Gutter when screen size is larger than theme.breakpoints.md */
  gutterMd?: MantineSpacing;

  /** Gutter when screen size is larger than theme.breakpoints.lg */
  gutterLg?: MantineSpacing;

  /** Gutter when screen size is larger than theme.breakpoints.xl */
  gutterXl?: MantineSpacing;

  /** Should columns in the last row take 100% of grid width */
  grow?: boolean;

  /** Set grid justify-content property */
  justify?: React.CSSProperties['justifyContent'];

  /** Set grid align-content property */
  align?: React.CSSProperties['alignContent'];

  /** Amount of columns in each row */
  columns?: number;

  containerName?: string;
}

type ForwardRefWithStaticComponents<
  Props extends Record<string, any>,
  Static extends Record<string, any>
> = ((props: Props) => React.ReactElement) &
  Static & {
    displayName: string;
  };

type GridComponent = ForwardRefWithStaticComponents<ContainerGridProps, { Col: typeof Col }>;

const defaultProps: Partial<ContainerGridProps> = {
  gutter: 'md',
  justify: 'flex-start',
  align: 'stretch',
  columns: 12,
};

export const ContainerGrid: GridComponent = forwardRef<HTMLDivElement, ContainerGridProps>(
  (props, ref) => {
    const {
      gutter,
      gutterXs,
      gutterSm,
      gutterMd,
      gutterLg,
      gutterXl,
      children,
      grow,
      justify,
      align,
      columns,
      className,
      id,
      unstyled,
      containerName,
      ...others
    } = useProps('Grid', defaultProps, props);
    // const { classes, cx } = useStyles(
    //   { gutter, justify, align, gutterXs, gutterSm, gutterMd, gutterLg, gutterXl, containerName },
    //   { unstyled, name: 'ContainerGrid' }
    // );

    const style = {
      '--grid-gutter': gutter ? `${gutter}px` : undefined,
      '--grid-gutter-xs': gutterXs ? `${gutterXs}px` : undefined,
      '--grid-gutter-sm': gutterSm ? `${gutterSm}px` : undefined,
      '--grid-gutter-md': gutterMd ? `${gutterMd}px` : undefined,
      '--grid-gutter-lg': gutterLg ? `${gutterLg}px` : undefined,
      '--grid-gutter-xl': gutterXl ? `${gutterXl}px` : undefined,
      '--grid-justify': justify,
      '--grid-align': align,
      ...(others.style ?? {}),
    } as React.CSSProperties;

    return (
      <ContainerGridProvider
        value={{
          gutter,
          gutterXs,
          gutterSm,
          gutterMd,
          gutterLg,
          gutterXl,
          grow,
          columns,
          containerName,
        }}
      >
        <Box className={clsx(classes.grid, className)} style={style} {...others} ref={ref}>
          {children}
        </Box>
      </ContainerGridProvider>
    );
  }
) as any;

ContainerGrid.Col = ContainerCol;
ContainerGrid.displayName = 'ContainerGrid';

type ContainerGrid2Props = Omit<GridProps, 'type' | 'breakpoints'>;
type GridComponent2 = ForwardRefWithStaticComponents<ContainerGrid2Props, { Col: typeof Grid.Col }>;

export const ContainerGrid2: GridComponent2 = forwardRef<
  HTMLDivElement,
  Omit<ContainerGrid2Props, 'type' | 'breakpoints'>
>(({ gutter = 'md', children, ...props }, ref) => {
  return (
    <Grid type="container" gutter={gutter} breakpoints={breakpoints} {...props}>
      {children}
    </Grid>
  );
});

ContainerGrid2.Col = Grid.Col;
ContainerGrid2.displayName = 'ContainerGrid2';
