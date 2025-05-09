import { MantineTheme, MantineSize, useMantineTheme, getSize } from '@mantine/core';
import React from 'react';
import { containerQuery } from '~/utils/mantine-css-helpers';

type MantineNumberSize = MantineSize | number;
const MANTINE_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;

export interface GridStylesParams {
  gutter: MantineNumberSize;
  gutterXs: MantineNumberSize;
  gutterSm: MantineNumberSize;
  gutterMd: MantineNumberSize;
  gutterLg: MantineNumberSize;
  gutterXl: MantineNumberSize;
  justify?: React.CSSProperties['justifyContent'];
  align?: React.CSSProperties['alignContent'];
  containerName?: string;
}

function getGutterStyles(gutters: Record<MantineSize, MantineNumberSize>, containerName?: string) {
  return MANTINE_SIZES.reduce<Record<string, React.CSSProperties>>((acc, size) => {
    if (typeof gutters[size] !== 'undefined') {
      acc[containerQuery.largerThan(size, containerName)] = {
        margin: -Number(getSize(gutters[size])) / 2,
      };
    }

    return acc;
  }, {});
}

const useContainerGridStyles = ({
  justify,
  align,
  gutter,
  gutterXs,
  gutterSm,
  gutterMd,
  gutterLg,
  gutterXl,
  containerName,
}: GridStylesParams) => {
  return {
    root: {
      margin: -Number(getSize(gutter)) / 2,
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: justify,
      alignItems: align,
      ...getGutterStyles(
        { xs: gutterXs, sm: gutterSm, md: gutterMd, lg: gutterLg, xl: gutterXl },
        containerName
      ),
    },
  };
};

export default useContainerGridStyles;
