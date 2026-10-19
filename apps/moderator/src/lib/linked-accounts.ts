// The `/api/linked-accounts` payload and the rules that order and select it. Plain TypeScript with no
// server imports, so the panel and the service share one definition and the rules are testable.

export const LINK_SIGNALS = ['regIp', 'nearLogin', 'buzz', 'social'] as const;
export type LinkSignal = (typeof LINK_SIGNALS)[number];

/** `off` is a signal whose settings are not configured on this deployment, which is not the same
 *  claim as `ok` with nothing found. */
export type SignalStatus = 'ok' | 'off' | 'failed';

export type LinkedAccountRow<D = string> = {
  userId: number;
  username: string | null;
  bannedAt: D | null;
  muted: boolean | null;
  /** `null` when the strike store could not be read. */
  strikes: number | null;
  regIp?: { ips: string[] };
  nearLogin?: { ips: string[]; closestSeconds: number; logins: number };
  /** `rank` is this counterparty's position among all of the account's Buzz counterparties. */
  buzz?: { rank: number; inCount: number; outCount: number; inAmount: number; outAmount: number };
  social?: { url: string };
};

export type LinkedAccounts = {
  accounts: LinkedAccountRow[];
  status: Record<LinkSignal, SignalStatus>;
  truncated: Record<LinkSignal, boolean>;
};

export const signalCount = (row: LinkedAccountRow<unknown>) =>
  LINK_SIGNALS.filter((s) => row[s] !== undefined).length;

/** Two independent kinds of evidence. One kind alone is common between unrelated accounts. */
export const isCorroborated = (row: LinkedAccountRow<unknown>) => signalCount(row) >= 2;

export function rankLinkedAccounts<T extends LinkedAccountRow<unknown>>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      signalCount(b) - signalCount(a) ||
      Number(!!b.bannedAt) - Number(!!a.bannedAt) ||
      (a.buzz?.rank ?? Infinity) - (b.buzz?.rank ?? Infinity) ||
      (a.nearLogin?.closestSeconds ?? Infinity) - (b.nearLogin?.closestSeconds ?? Infinity) ||
      a.userId - b.userId
  );
}

/**
 * What the Bulk Ban hand-off starts with. Empty for every row, corroborated and banned ones included:
 * this list is evidence, and each account is a moderator's decision.
 */
export function initialBanSelection(_rows: LinkedAccountRow<unknown>[]): number[] {
  return [];
}

export const toggleId = (ids: number[], id: number) =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];

export const bulkBanHref = (ids: number[]) =>
  ids.length ? `/retool/bulk-ban?ids=${encodeURIComponent(ids.join('\n'))}` : null;

/** Seconds between `t` and the nearest of `times`. */
export const nearestGapSeconds = (times: number[], t: number) =>
  Math.min(...times.map((x) => Math.abs(x - t)));

export const gapLabel = (seconds: number) =>
  seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;

export async function fetchLinkedAccounts(
  userId: number,
  version: number
): Promise<LinkedAccounts> {
  const r = await fetch(`/api/linked-accounts/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
