// @ts-nocheck
import React, { forwardRef } from 'react';

import { useContainerGridContext } from './ContainerGrid.context';
import useStyles from './ContainerCol.styles';
import { Box, ColSpan, DefaultProps, useComponentDefaultProps } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';
import styles from './ContainerCol.module.scss';

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

  containerName?: string;
}

const defaultProps: Partial<ColProps> = {};

function isValidSpan(span: ColSpan) {
  if (span === 'auto' || span === 'content') {
    return true;
  }
  return typeof span === 'number' && span > 0 && span % 1 === 0;
}

const getColumnFlexBasis = (colSpan: ColSpan, columns: number) => {
  if (colSpan === 'content') {
    return 'auto';
  }
  if (colSpan === 'auto') {
    return '0px';
  }
  return colSpan ? `${100 / (columns / colSpan)}%` : undefined;
};

const getColumnMaxWidth = (colSpan: ColSpan, columns: number, grow: boolean) => {
  if (grow || colSpan === 'auto' || colSpan === 'content') {
    return 'unset';
  }
  return getColumnFlexBasis(colSpan, columns);
};

const getColumnFlexGrow = (colSpan: ColSpan, grow: boolean) => {
  if (!colSpan) {
    return undefined;
  }
  return colSpan === 'auto' || grow ? 1 : 0;
};

const getColumnOffset = (offset: number, columns: number) =>
  offset === 0 ? 0 : offset ? `${100 / (columns / offset)}%` : undefined;

const getGutterSize = (gutter: number) => (typeof gutter !== 'undefined' ? gutter / 2 : undefined);

function getBreakpointsStyles({
  sizes,
  offsets,
  orders,
  columns,
  gutters,
  grow,
  containerName,
}: {
  sizes: Record<string, ColSpan>;
  offsets: Record<string, number>;
  orders: Record<string, React.CSSProperties['order']>;
  gutters: Record<string, number>;
  grow: boolean;
  columns: number;
  containerName?: string;
}) {
  return Object.entries(sizes).reduce<Record<string, React.CSSProperties>>(
    (acc, [size, colSpan]) => {
      acc[containerQuery.largerThan(size, containerName)] = {
        order: orders[size],
        flexBasis: getColumnFlexBasis(colSpan, columns),
        padding: getGutterSize(gutters[size]),
        flexShrink: 0,
        width: colSpan === 'content' ? 'auto' : undefined,
        maxWidth: getColumnMaxWidth(colSpan, columns, grow),
        marginLeft: getColumnOffset(offsets[size], columns),
        flexGrow: getColumnFlexGrow(colSpan, grow),
      };
      return acc;
    },
    {}
  );
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
    containerName,
  } = useComponentDefaultProps('GridCol', defaultProps, props);

  const ctx = useContainerGridContext();

  const colSpan = span || ctx.columns;
  const { classes, cx } = useStyles(
    {
      gutter: ctx.gutter,
      gutterXs: ctx.gutterXs,
      gutterSm: ctx.gutterSm,
      gutterMd: ctx.gutterMd,
      gutterLg: ctx.gutterLg,
      gutterXl: ctx.gutterXl,
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
      grow: ctx.grow,
      columns: ctx.columns,
      span: colSpan,
      containerName: containerName || ctx.containerName,
    },
    { unstyled, name: 'ContainerGrid' }
  );

  const style = {
    flexGrow: getColumnFlexGrow(colSpan, false),
    order,
    padding: getGutterSize(0),
    marginLeft: getColumnOffset(offset, 12),
    flexBasis: getColumnFlexBasis(colSpan, 12),
    width: colSpan === 'content' ? 'auto' : undefined,
    maxWidth: getColumnMaxWidth(colSpan, 12, false),
  };

  const mediaQueries = getBreakpointsStyles({
    sizes: { xs, sm, md, lg, xl },
    offsets: { xs: offsetXs, sm: offsetSm, md: offsetMd, lg: offsetLg, xl: offsetXl },
    orders: { xs: orderXs, sm: orderSm, md: orderMd, lg: orderLg, xl: orderXl },
    gutters: { xs: 0, sm: 0, md: 0, lg: 0, xl: 0 },
    columns: 12,
    grow: false,
    containerName: containerName || ctx.containerName,
  });

  if (!isValidSpan(colSpan) || (typeof colSpan === 'number' && colSpan > ctx.columns)) {
    return null;
  }

  return (
    <Box className={cx(classes.col, className)} ref={ref} style={{ ...style, ...mediaQueries }}>
      {children}
    </Box>
  );
});

ContainerCol.displayName = 'ContainerCol';


