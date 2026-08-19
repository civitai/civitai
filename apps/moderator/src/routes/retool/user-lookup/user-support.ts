// The `/api/user-support` payload, declared once for both the endpoint and the panel. Declared here
// rather than imported from `$lib/server/*` because it crosses a JSON boundary — `Date` arrives as
// `string` — and importing a server module into a component invites it into the client bundle.

export type TimedMute = {
  id: number;
  muteStart: string | null;
  muteEnd: string | null;
  createdBy: string | null;
  muteReason: string | null;
  /** Derived server-side from both the revocation flag and `muteEnd` — Retool and this app disagree
   *  about which one means "active", so the panel must not re-derive it. */
  active: boolean;
};

export type FreshdeskResult =
  | {
      status: 'found';
      contact: { id: number; name: string | null; email: string | null; url: string };
    }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

export type Support = { timedMutes: TimedMute[]; freshdesk: FreshdeskResult };

export async function fetchSupport(userId: number, version: number): Promise<Support> {
  const r = await fetch(`/api/user-support/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
