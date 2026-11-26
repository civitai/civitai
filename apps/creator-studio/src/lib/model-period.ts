// Whether /analytics/models shows the selected month or the creator's whole history. Its own cookie, not the shared
// analytics period: no other page has an all-time read, so none of them should ever see 'all'.
export const MODEL_PERIOD_COOKIE = 'cs-model-period';

export type ModelPeriod = 'month' | 'all';

export function parseModelPeriod(raw: string | null | undefined): ModelPeriod {
  return raw === 'all' ? 'all' : 'month';
}
