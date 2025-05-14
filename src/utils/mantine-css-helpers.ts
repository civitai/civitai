import { MantineSpacing } from '@mantine/core';

export const mantineContainerSizes: Record<MantineSpacing, number> = {
  xs: 576,
  sm: 768,
  md: 992,
  lg: 1200,
  xl: 1400,
};

export const containerQuery = {
  largerThan: (size: MantineSpacing | number, containerName?: string) => {
    const value = typeof size === 'string' ? mantineContainerSizes[size] : size;
    if (containerName) return `@container ${containerName} (width >= ${value}px)`;
    return `@container (width >=  ${value}px)`;
  },
  smallerThan: (size: MantineSpacing | number, containerName?: string) => {
    const value = typeof size === 'string' ? mantineContainerSizes[size] : size;
    if (containerName) return `@container ${containerName} (width < ${value}px)`;
    return `@container (width < ${value}px)`;
  },
};
