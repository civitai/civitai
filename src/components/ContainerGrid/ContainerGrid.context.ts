import type { MantineSpacing } from '@mantine/core';
import { createSafeContext } from '@mantine/core';

interface GridContextValue {
  gutter: MantineSpacing;
  gutterXs: MantineSpacing;
  gutterSm: MantineSpacing;
  gutterMd: MantineSpacing;
  gutterLg: MantineSpacing;
  gutterXl: MantineSpacing;
  grow: boolean;
  columns: number;
  containerName?: string;
}

export const [ContainerGridProvider, useContainerGridContext] = createSafeContext<GridContextValue>(
  'Container grid component was not found in tree'
);
