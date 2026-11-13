import { browser } from '$app/environment';
import { SSR_PENDING } from '$lib/ssr-pending';
import { fetchModelFlagDetail, type ModelFlagDetail } from '$lib/minor-flags/model-detail';

/** The ids a pane asks `promptVersions` for, as one string so a `$derived` over it compares by value. */
export const promptKeyOf = (ids: readonly (number | null)[]) =>
  ids.filter((id): id is number => id !== null).join(',');

/**
 * A Model Flags pane's detail request. Call it in a `$derived` over primitives — the model id and
 * `promptKeyOf`'s string, each its own `$derived` — so a reload that hands back an equal row keeps the
 * request; never from an effect, since `TriageShell` keys the pane per row and a late response must
 * not land on another one.
 */
export const modelFlagDetail = (
  tabPath: string,
  modelId: number,
  promptKey: string
): Promise<ModelFlagDetail> =>
  browser
    ? fetchModelFlagDetail(tabPath, modelId, promptKey ? promptKey.split(',').map(Number) : [])
    : SSR_PENDING;
