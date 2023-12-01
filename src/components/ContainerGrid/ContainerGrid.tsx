// @ts-nocheck
import React, { forwardRef } from 'react';
import { DefaultProps, MantineNumberSize, useComponentDefaultProps } from '@mantine/styles';

import { ContainerCol } from './ContainerCol';
import { ContainerGridProvider } from './ContainerGrid.context';
import useStyles from './ContainerGrid.styles';
import { Box } from '@mantine/core';

export interface ContainerGridProps extends DefaultProps, React.ComponentPropsWithRef<'div'> {
  /** <Col /> components only */
  children: React.ReactNode;

  /** Spacing between columns, key of theme.spacing or number for value in px  */
  gutter?: MantineNumberSize;

  /** Gutter when screen size is larger than theme.breakpoints.xs */
  gutterXs?: MantineNumberSize;

  /** Gutter when screen size is larger than theme.breakpoints.sm */
  gutterSm?: MantineNumberSize;

  /** Gutter when screen size is larger than theme.breakpoints.md */
  gutterMd?: MantineNumberSize;

  /** Gutter when screen size is larger than theme.breakpoints.lg */
  gutterLg?: MantineNumberSize;

  /** Gutter when screen size is larger than theme.breakpoints.xl */
  gutterXl?: MantineNumberSize;

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
    } = useComponentDefaultProps('Grid', defaultProps, props);
    const { classes, cx } = useStyles(
      { gutter, justify, align, gutterXs, gutterSm, gutterMd, gutterLg, gutterXl, containerName },
      { unstyled, name: 'ContainerGrid' }
    );

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
        <Box className={cx(classes.root, className)} {...others} ref={ref}>
          {children}
        </Box>
      </ContainerGridProvider>
    );
  }
) as any;

ContainerGrid.Col = ContainerCol;
ContainerGrid.displayName = 'ContainerGrid';
