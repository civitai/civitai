import type { Jsonified } from '$lib/format';
import type {
  ModelRuleHoldHistoryEntry,
  OwnerRuleHolds,
} from '$lib/server/model-rule-holds.queries';

/** The payload of `/api/model-rule-hold-context/[holdId]`; a part is null when its read failed. */
export type HoldContext = {
  owner: Jsonified<OwnerRuleHolds> | null;
  history: Jsonified<ModelRuleHoldHistoryEntry>[] | null;
};

const loaded = new Map<number, Promise<HoldContext>>();

/** Fetched once per hold: moving back to a hold already opened reuses its context. A failure is not
 *  kept, so the next try asks again. */
export function fetchHoldContext(holdId: number): Promise<HoldContext> {
  const cached = loaded.get(holdId);
  if (cached) return cached;
  const request = fetch(`/api/model-rule-hold-context/${holdId}`)
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<HoldContext>;
    })
    .catch((err) => {
      loaded.delete(holdId);
      throw err;
    });
  loaded.set(holdId, request);
  return request;
}

/** After a decision every cached context is out of date: it lists holds that may just have been decided. */
export const forgetHoldContexts = () => loaded.clear();

/** What a decision did to one of the owner's other holds, as the page action reports it. */
export type OwnerResult = { holdId: number; ok: boolean; error?: string };
