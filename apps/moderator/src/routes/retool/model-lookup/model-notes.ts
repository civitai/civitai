import type { Jsonified } from '$lib/format';
import type { ModelNote as ServerModelNote } from '$lib/server/model-notes.service';

export type ModelNote = Jsonified<ServerModelNote>;

export async function fetchModelNotes(modelId: number, version: number): Promise<ModelNote[]> {
  const r = await fetch(`/api/model-notes/${modelId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  const body: { notes: ModelNote[] } = await r.json();
  return body.notes;
}

/** The `content` column is unconstrained text; this is the app's own cap, enforced by the action. */
export const NOTE_MAX = 5000;
