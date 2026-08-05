// Whether /analytics/models lists one row per version or rolls versions up into their model.
//
// A cookie rather than localStorage because it decides which ROWS exist: read only in the browser, the
// server would render the version list and the table would visibly regroup on hydration. Host-only, so it
// stays on creator-studio.
export const MODEL_GROUPING_COOKIE = 'cs-model-grouping';

export const MODEL_GROUPINGS = ['version', 'model'] as const;
export type ModelGrouping = (typeof MODEL_GROUPINGS)[number];

// Version is the default: it's the finer view, and rolling up hides which version is actually earning.
export function parseModelGrouping(raw: string | null | undefined): ModelGrouping {
  return raw === 'model' ? 'model' : 'version';
}
