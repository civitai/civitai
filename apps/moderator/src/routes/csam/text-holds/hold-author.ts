import type { Jsonified } from '$lib/format';
import type { AuthorHoldSummary } from '$lib/server/csam-holds.queries';
import type { ReportedContent, UserCard, UserCounts } from '$lib/server/user-lookup.service';

/** The payload of `/api/csam-hold-author/[holdId]`. */
export type HoldAuthor = {
  userId: number;
  /** Null for a moderator who cannot open User Lookup: the card carries an email and the account's standing. */
  card: Jsonified<UserCard> | null;
  counts: Jsonified<UserCounts> | null;
  reportedContent: ReportedContent[] | null;
  holds: {
    /** Every other hold of the author, counting the decided ones past `others`. */
    total: number;
    /** All the author's other pending holds, which `others` lists in full. */
    pendingTotal: number;
    others: Jsonified<AuthorHoldSummary>[];
  };
};

const loaded = new Map<number, Promise<HoldAuthor>>();

/** Fetched once per hold: moving back to a hold already opened reuses its author. A failure is not
 *  kept, so the next try asks again. */
export function fetchHoldAuthor(holdId: number): Promise<HoldAuthor> {
  const cached = loaded.get(holdId);
  if (cached) return cached;
  const request = fetch(`/api/csam-hold-author/${holdId}`)
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<HoldAuthor>;
    })
    .catch((err) => {
      loaded.delete(holdId);
      throw err;
    });
  loaded.set(holdId, request);
  return request;
}

/** After a decision every cached author is out of date: it lists holds that may just have been decided. */
export const forgetHoldAuthors = () => loaded.clear();

type OtherHold = Pick<Jsonified<AuthorHoldSummary>, 'id' | 'entityType' | 'status' | 'textHash'>;

/** One decision applies to at most this many other holds, the form's and the main app's batch limit. */
export const ALSO_MAX = 50;

/** The author's other pending holds that `decision` can cover for this type. */
export function alsoDecidable(
  others: readonly OtherHold[],
  decision: string,
  canRemove: (entityType: string) => boolean
): { holdId: number; textHash: string }[] {
  return others.flatMap((hold) =>
    hold.status === 'Pending' &&
    hold.textHash !== null &&
    (decision === 'dismiss' || canRemove(hold.entityType))
      ? [{ holdId: hold.id, textHash: hold.textHash }]
      : []
  );
}

/** What a decision did to one of the author's other holds, as the page action reports it. */
export type AlsoResult = { holdId: number; ok: boolean; error?: string };
