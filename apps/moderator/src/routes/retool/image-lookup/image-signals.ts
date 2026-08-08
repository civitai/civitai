// The `/api/image-signals` payload, declared once for the endpoint and the panel. Page-local because it
// crosses a JSON boundary — `Date` arrives as `string` — and a component must not import from
// `$lib/server/*`.

export type ImageEvent = {
  key: string;
  type: string;
  time: string;
  userId: number;
  tosReason: string | null;
  violationType: string | null;
  violationDetails: string;
};

export type ReactionCluster = {
  ip: string;
  reactions: number;
  accounts: { userId: number; username: string | null; bannedAt: string | null }[];
};

export type ReactionSignals = {
  totalReactions: number;
  distinctIps: number;
  clusters: ReactionCluster[];
  truncated: boolean;
};

export type ImageSignals = {
  events: { rows: ImageEvent[]; truncated: boolean };
  reactions: ReactionSignals | null;
};

export async function fetchImageSignals(imageId: number): Promise<ImageSignals> {
  const r = await fetch(`/api/image-signals/${imageId}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
