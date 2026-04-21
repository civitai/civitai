export const colorDomainNames = ['green', 'blue', 'red'] as const;
export type ColorDomain = (typeof colorDomainNames)[number];
export type ServerDomains = Record<ColorDomain, string | undefined>;
