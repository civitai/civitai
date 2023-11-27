import { MantineSize } from '@mantine/core';

export const mantineContainerSizes: Record<MantineSize, number> = {
  xs: 576,
  sm: 768,
  md: 992,
  lg: 1200,
  xl: 1400,
};

export const containerQuery = {
  largerThan: (size: MantineSize, containerName?: string) => {
    if (containerName)
      return `@container ${containerName} (min-width: ${mantineContainerSizes[size]}px)`;
    return `@container (min-width: ${mantineContainerSizes[size]}px)`;
  },
  smallerThan: (size: MantineSize, containerName?: string) => {
    if (containerName)
      return `@container ${containerName} (max-width: ${mantineContainerSizes[size] - 1}px)`;
    return `@container (max-width: ${mantineContainerSizes[size] - 1}px)`;
  },
};
