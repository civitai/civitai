// @ts-nocheck
import React, { forwardRef } from 'react';

import { useContainerGridContext } from './ContainerGrid.context';
// import useStyles from './ContainerCol.styles';
import { Box, ColSpan, DefaultProps, useProps } from '@mantine/core';
import classes from './ContainerCol.module.scss';

export interface ColProps extends DefaultProps, React.ComponentPropsWithoutRef<'div'> {
  /** Default col span */
  span?: ColSpan;

  /** Column left offset */
  offset?: number;

  /** Default col order */
  order?: React.CSSProperties['order'];

  /** Col order at (min-width: theme.breakpoints.xs) */
  orderXs?: React.CSSProperties['order'];

  /** Col order at (min-width: theme.breakpoints.sm) */
  orderSm?: React.CSSProperties['order'];

  /** Col order at (min-width: theme.breakpoints.md) */
  orderMd?: React.CSSProperties['order'];

  /** Col order at (min-width: theme.breakpoints.lg) */
  orderLg?: React.CSSProperties['order'];

  /** Col order at (min-width: theme.breakpoints.xl) */
  orderXl?: React.CSSProperties['order'];

  /** Column left offset at (min-width: theme.breakpoints.xs) */
  offsetXs?: number;

  /** Column left offset at (min-width: theme.breakpoints.sm) */
  offsetSm?: number;

  /** Column left offset at (min-width: theme.breakpoints.md) */
  offsetMd?: number;

  /** Column left offset at (min-width: theme.breakpoints.lg) */
  offsetLg?: number;

  /** Column left offset at (min-width: theme.breakpoints.xl) */
  offsetXl?: number;

  /** Col span at (min-width: theme.breakpoints.xs) */
  xs?: ColSpan;

  /** Col span at (min-width: theme.breakpoints.sm) */
  sm?: ColSpan;

  /** Col span at (min-width: theme.breakpoints.md) */
  md?: ColSpan;

  /** Col span at (min-width: theme.breakpoints.lg) */
  lg?: ColSpan;

  /** Col span at (min-width: theme.breakpoints.xl) */
  xl?: ColSpan;
}

const defaultProps: Partial<ColProps> = {};

function isValidSpan(span: ColSpan) {
  if (span === 'auto' || span === 'content') {
    return true;
  }
  return typeof span === 'number' && span > 0 && span % 1 === 0;
}

export const ContainerCol = forwardRef<HTMLDivElement, ColProps>((props: ColProps, ref) => {
  const {
    children,
    span,
    offset,
    offsetXs,
    offsetSm,
    offsetMd,
    offsetLg,
    offsetXl,
    xs,
    sm,
    md,
    lg,
    xl,
    order,
    orderXs,
    orderSm,
    orderMd,
    orderLg,
    orderXl,
    className,
    id,
    unstyled,
    ...others
  } = useProps('GridCol', defaultProps, props);

  const ctx = useContainerGridContext();

  const colSpan = span || ctx.columns;

  const style = {
    '--col-gutter': ctx.gutter,
    '--col-gutter-xs': ctx.gutterXs,
    '--col-gutter-sm': ctx.gutterSm,
    '--col-gutter-md': ctx.gutterMd,
    '--col-gutter-lg': ctx.gutterLg,
    '--col-gutter-xl': ctx.gutterXl,
    '--col-offset': offset,
    '--col-offset-xs': offsetXs,
    '--col-offset-sm': offsetSm,
    '--col-offset-md': offsetMd,
    '--col-offset-lg': offsetLg,
    '--col-offset-xl': offsetXl,
    '--col-span': colSpan,
    '--col-span-xs': xs,
    '--col-span-sm': sm,
    '--col-span-md': md,
    '--col-span-lg': lg,
    '--col-span-xl': xl,
    '--col-order': order,
    '--col-order-xs': orderXs,
    '--col-order-sm': orderSm,
    '--col-order-md': orderMd,
    '--col-order-lg': orderLg,
    '--col-order-xl': orderXl,
    '--col-columns': ctx.columns,
    '--col-grow': ctx.grow ? 1 : 0,
    ...(others.style ?? {}),
  } as React.CSSProperties;

  if (!isValidSpan(colSpan) || (typeof colSpan === 'number' && colSpan > ctx.columns)) {
    return null;
  }

  return (
    <Box className={className} ref={ref} style={style} {...others}>
      {children}
    </Box>
  );
});

ContainerCol.displayName = 'ContainerCol';
