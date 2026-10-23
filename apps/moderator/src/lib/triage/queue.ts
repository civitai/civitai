/** What an item shows once decided; a function reads it from the form being submitted. */
export type Outcome = string | ((form: FormData) => string);

type ActionResultLike = { type: string; data?: Record<string, unknown> };

/** The message to show against an item whose action did not succeed, or null. */
export function failureMessage(result: ActionResultLike): string | null {
  if (result.type === 'success') return null;
  const error = result.type === 'failure' ? result.data?.error : null;
  return typeof error === 'string' ? error : 'Action failed.';
}

/** The banner for a failed action: the error, led by the item it concerns when the action named one. */
export function failureBanner(form: { error?: string; subject?: string } | null | undefined) {
  if (!form?.error) return null;
  return form.subject ? `${form.subject}: ${form.error}` : form.error;
}

/** One step through the queue, clamped at both ends. */
export function step<K extends string | number>(
  ids: readonly K[],
  current: K | null,
  direction: 1 | -1
) {
  if (!ids.length) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, at + direction))];
}

/** The next item still waiting on a decision: forward from `current` first, then back. */
export function nextUndecided<K extends string | number>(
  ids: readonly K[],
  current: K | null,
  isDecided: (id: K) => boolean
): K | null {
  const at = current === null ? -1 : ids.indexOf(current);
  for (let i = at + 1; i < ids.length; i++) if (!isDecided(ids[i])) return ids[i];
  for (let i = Math.min(at, ids.length) - 1; i >= 0; i--) if (!isDecided(ids[i])) return ids[i];
  return null;
}

/** Keeps the page's query on a form action URL so a no-JS submit lands on the same filters. */
export function formActionHref(
  action: string,
  params: Record<string, string | number | undefined>
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') query.set(key, String(value));
  const rest = query.toString();
  return rest ? `?/${action}&${rest}` : `?/${action}`;
}
