// The `/api/user-membership-codes` payload, shared by the endpoint and the panel.

import type { Jsonified } from '$lib/format';
import type { SupportMembershipCodeRow } from '$lib/server/membership-code.service';

export type SupportMembershipCode = Jsonified<SupportMembershipCodeRow>;

export async function fetchMembershipCodes(
  userId: number,
  version: number
): Promise<SupportMembershipCode[]> {
  const r = await fetch(`/api/user-membership-codes/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
