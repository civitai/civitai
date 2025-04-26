// @ts-nocheck
import React, { forwardRef } from 'react';
import { DefaultProps, MantineNumberSize, useComponentDefaultProps } from '@mantine/styles';
import { Box, BoxProps } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';
import styles from './ContainerGrid.module.scss';

import { ContainerCol } from './ContainerCol';
import { ContainerGridProvider } from './ContainerGrid.context';
import useStyles from './ContainerGrid.styles';

export interface ContainerGridProps extends DefaultProps, React.ComponentPropsWithRef<'div'> {
  /** <Col /> components only */
  children: React.ReactNode;

  /** Spacing between columns, key of theme.spacing or number for value in px  */
  gutter?: number;

  /** Gutter when screen size is larger than theme.breakpoints.xs */
  gutterXs?: number;

  /** Gutter when screen size is larger than theme.breakpoints.sm */
  gutterSm?: number;

  /** Gutter when screen size is larger than theme.breakpoints.md */
  gutterMd?: number;

  /** Gutter when screen size is larger than theme.breakpoints.lg */
  gutterLg?: number;

  /** Gutter when screen size is larger than theme.breakpoints.xl */
  gutterXl?: number;

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
  gutter: 0,
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

    const getGutterStyle = (size: number) => ({
      margin: `-${size / 2}px`,
    });

    const style = {
      ...getGutterStyle(gutter),
      justifyContent: justify,
      alignItems: align,
    };

    const mediaQueries = {
      [containerQuery.largerThan('xs', containerName)]: gutterXs ? getGutterStyle(gutterXs) : {},
      [containerQuery.largerThan('sm', containerName)]: gutterSm ? getGutterStyle(gutterSm) : {},
      [containerQuery.largerThan('md', containerName)]: gutterMd ? getGutterStyle(gutterMd) : {},
      [containerQuery.largerThan('lg', containerName)]: gutterLg ? getGutterStyle(gutterLg) : {},
      [containerQuery.largerThan('xl', containerName)]: gutterXl ? getGutterStyle(gutterXl) : {},
    };

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
        <Box
          className={`${styles.root} ${cx(classes.root, className)}`}
          style={{ ...style, ...mediaQueries }}
          {...others}
          ref={ref}
        >
          {children}
        </Box>
      </ContainerGridProvider>
    );
  }
) as any;

ContainerGrid.Col = ContainerCol;
ContainerGrid.displayName = 'ContainerGrid';


