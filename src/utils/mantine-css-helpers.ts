import type { MantineSpacing } from '@mantine/core';

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

export const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
};

export const hexToRgbOpenEnded = (hex: string) => {
  const data = hexToRgb(hex);
  if (!data) return hex;
  return `${data.r}, ${data.g}, ${data.b}`;
};
