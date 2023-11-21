import { MantineSize } from '@mantine/core';

const containerSizes: Record<MantineSize, number> = {
  xs: 576,
  sm: 768,
  md: 992,
  lg: 1200,
  xl: 1400,
};

export const containerQuery = {
  largerThan: (size: MantineSize, containerName?: string) => {
    if (containerName) return `@container ${containerName} (min-width: ${containerSizes[size]}px)`;
    return `@container (min-width: ${containerSizes[size]}px)`;
  },
  smallerThan: (size: MantineSize, containerName?: string) => {
    if (containerName)
      return `@container ${containerName} (max-width: ${containerSizes[size] - 1}px)`;
    return `@container (max-width: ${containerSizes[size] - 1}px)`;
  },
};
