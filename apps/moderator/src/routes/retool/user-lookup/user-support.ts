// The `/api/user-support` payload, declared once for both the endpoint and the panel. Declared here
// rather than imported from `$lib/server/*` because it crosses a JSON boundary — `Date` arrives as
// `string` — and importing a server module into a component invites it into the client bundle.

/** The account's current timed mute. One or none — it is `User.muteExpiresAt`, a single column, not a
 *  list of rows that could disagree with the account. */
export type TimedMute = {
  muteExpiresAt: string;
  /** `strikes` carries no reason or moderator — the escalation engine set it, not a person. */
  source: 'moderator' | 'strikes';
  mutedAt: string | null;
  reason: string | null;
  mutedBy: number | null;
};

export type FreshdeskResult =
  | {
      status: 'found';
      contact: { id: number; name: string | null; email: string | null; url: string };
    }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

export type Support = { timedMute: TimedMute | null; freshdesk: FreshdeskResult };

export async function fetchSupport(userId: number, version: number): Promise<Support> {
  const r = await fetch(`/api/user-support/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
