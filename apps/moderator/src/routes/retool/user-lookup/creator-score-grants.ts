import type { Jsonified } from '$lib/format';
import type { CreatorScoreGrantRow } from '$lib/server/creator-score-grant.service';

export type CreatorScoreGrant = Jsonified<CreatorScoreGrantRow>;

export async function fetchCreatorScoreGrants(
  userId: number,
  version: number
): Promise<CreatorScoreGrant[]> {
  const r = await fetch(`/api/creator-score-grants/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
