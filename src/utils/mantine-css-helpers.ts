import { MantineSpacing } from '@mantine/core';

export const mantineContainerSizes: Record<MantineSpacing, number> = {
  xs: 480,
  sm: 768,
  md: 1024,
  lg: 1184,
  xl: 1440,
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
