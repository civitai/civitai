import { MantineSize, createSafeContext } from '@mantine/core';

type MantineNumberSize = MantineSize | number;

interface GridContextValue {
  gutter: MantineNumberSize;
  gutterXs: MantineNumberSize;
  gutterSm: MantineNumberSize;
  gutterMd: MantineNumberSize;
  gutterLg: MantineNumberSize;
  gutterXl: MantineNumberSize;
  grow: boolean;
  columns: number;
  containerName?: string;
}

export const [ContainerGridProvider, useContainerGridContext] = createSafeContext<GridContextValue>(
  'Container grid component was not found in tree'
);
