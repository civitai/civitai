import { createSafeContext } from '@mantine/utils';
import type { MantineNumberSize } from '@mantine/styles';

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
