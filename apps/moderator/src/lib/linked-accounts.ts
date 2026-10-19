// No server imports: the panel imports this file, and the service shares the definitions.

export const LINK_SIGNALS = ['regIp', 'nearLogin', 'buzz', 'social'] as const;
export type LinkSignal = (typeof LINK_SIGNALS)[number];

/** `off` is a signal whose settings are not configured on this deployment, which is not the same
 *  claim as `ok` with nothing found. */
export type SignalStatus = 'ok' | 'off' | 'failed';

export type AccountLinkRow = {
  userId: number;
  username: string | null;
  /** `gone`: no `User` row. Mirrors `accountStatus` in `users.service.ts`. */
  status: 'active' | 'banned' | 'deleted' | 'gone';
  muted: boolean | null;
  /** `null` when the strike store could not be read. */
  strikes: number | null;
  regIp?: { ips: string[] };
  /** `ips` is a sample of at most 10; `addresses` is the full count. */
  nearLogin?: { ips: string[]; addresses: number; closestSeconds: number; logins: number };
  /** `rank` is this counterparty's position among all of the account's Buzz counterparties. */
  buzz?: { rank: number; inCount: number; outCount: number; inAmount: number; outAmount: number };
  social?: { url: string };
};

export type AccountLinks = {
  accounts: AccountLinkRow[];
  status: Record<LinkSignal, SignalStatus>;
  truncated: Record<LinkSignal, boolean>;
};

export const signalCount = (row: AccountLinkRow) =>
  LINK_SIGNALS.filter((s) => row[s] !== undefined).length;

export const isCorroborated = (row: AccountLinkRow) => signalCount(row) >= 2;

export function rankAccountLinks(rows: AccountLinkRow[]): AccountLinkRow[] {
  return [...rows].sort(
    (a, b) =>
      signalCount(b) - signalCount(a) ||
      Number(b.status === 'banned') - Number(a.status === 'banned') ||
      (a.buzz?.rank ?? Infinity) - (b.buzz?.rank ?? Infinity) ||
      (a.nearLogin?.closestSeconds ?? Infinity) - (b.nearLogin?.closestSeconds ?? Infinity) ||
      a.userId - b.userId
  );
}
