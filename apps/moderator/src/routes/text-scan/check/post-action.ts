import type { ActionResult } from '@sveltejs/kit';
import { deserialize } from '$app/forms';

export type PostAction = (
  name: string,
  fields: Record<string, string>,
  opts?: { keepalive?: boolean }
) => Promise<ActionResult>;

/**
 * Posts to one of this page's actions outside a form (autosave, discard, copy). `keepalive` lets a save
 * started as the page unloads finish after it.
 */
export const postAction: PostAction = async (name, fields, { keepalive = false } = {}) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  try {
    const res = await fetch(`/text-scan/check?/${name}`, {
      method: 'POST',
      body,
      headers: { 'x-sveltekit-action': 'true' },
      keepalive,
    });
    return deserialize(await res.text());
  } catch {
    return { type: 'failure', status: 0, data: { error: 'Could not reach the server.' } };
  }
};
