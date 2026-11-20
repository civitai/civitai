export const PRESERVED_VIEW_PAGE = '/csam/preserved-view';

/** Sent by the page's own fetch of a file; the route refuses a request without it. */
export const PRESERVED_VIEW_HEADER = 'x-preserved-view';

export const PRESERVED_VERDICTS = ['apparent', 'not'] as const;
export type PreservedVerdict = (typeof PRESERVED_VERDICTS)[number];

export const isPreservedVerdict = (value: unknown): value is PreservedVerdict =>
  (PRESERVED_VERDICTS as readonly unknown[]).includes(value);

export const PRESERVED_VERDICT_LABELS: Record<PreservedVerdict, string> = {
  apparent: 'Apparent CSAM',
  not: 'Not apparent CSAM',
};
