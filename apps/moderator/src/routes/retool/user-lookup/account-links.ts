import type { AccountLinkRow, AccountLinks } from '$lib/linked-accounts';

export async function fetchAccountLinks(userId: number, version: number): Promise<AccountLinks> {
  const r = await fetch(`/api/linked-accounts/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

export const toggleId = (ids: number[], id: number) =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];

/**
 * The ids to hand to Bulk Ban: the ones ticked that are still on screen. A refetch can drop a row, and
 * a tick on a row no longer shown must not travel. Never adds an id: nothing is selected for a ban
 * that a moderator did not tick.
 */
export const reconcileSelection = (ticked: number[], rows: AccountLinkRow[], subjectId: number) =>
  ticked.filter((id) => id === subjectId || rows.some((r) => r.userId === id));

export const gapLabel = (seconds: number) =>
  seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
