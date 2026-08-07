// The `/api/user-memory` payload, declared once for both the endpoint and the panel. Same reasoning as
// user-support.ts: it crosses a JSON boundary, so dates are strings, and a component must not import
// from `$lib/server/*`.

export type Note = {
  id: number;
  notes: string | null;
  lastUpdate: string | null;
  lastUpdateBy: string | null;
  isMine: boolean;
};

export type Strike = {
  id: number;
  reason: string | null;
  createdAt: string | null;
  createdBy: string | null;
};

export type ModerationFlags = { spamWhitelist: boolean; deservedMute: boolean };

export type Memory = { notes: Note[]; strikes: Strike[]; flags: ModerationFlags };

export async function fetchMemory(userId: number, version: number): Promise<Memory> {
  const r = await fetch(`/api/user-memory/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
