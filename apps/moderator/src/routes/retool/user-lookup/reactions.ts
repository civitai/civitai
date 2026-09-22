import type { ReactionSummary } from '$lib/server/user-account.service';
import type { Jsonified } from '$lib/format';

// The `/api/user-reactions` payload. Its own endpoint — see that route for why.

export type Reactions = Jsonified<ReactionSummary>;

export async function fetchReactions(userId: number): Promise<Reactions> {
  const r = await fetch(`/api/user-reactions/${userId}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
