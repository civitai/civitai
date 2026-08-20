// The `/api/image-signals` payload, declared once for the endpoint and the panel.
//
// DERIVED from the service's row type through `Jsonified`, not hand-copied: the copy drifted the first
// time a column was added, and a missing field on a type like this surfaces as a silently unrendered
// value rather than an error. `import type` is erased at build, so no server code reaches the bundle.
import type { ImageEvent as ImageEventRow } from '$lib/server/image-signals.service';
import type { Jsonified } from '$lib/format';

export type ImageEvent = Jsonified<ImageEventRow>;

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
