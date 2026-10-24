/**
 * The embedded Training Studio's `checkTrainingText` host hook: asks this app's trigger word check
 * about one run. Only an explicit `{ ok: true }` passes; a 400 is a refusal carrying its reason, and
 * anything else rejects, so the element submits nothing.
 */
export async function checkStudioTriggerWord(
  input: { triggerWord: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await fetchImpl('/api/training-studio/check-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    redirect: 'error',
  });
  const data = (await r.json().catch(() => null)) as {
    ok?: unknown;
    message?: string;
    error?: string;
  } | null;
  // A refusal's reason arrives as `message`; the route's answer to a malformed body uses `error`.
  const detail = data?.message ?? data?.error;
  if (r.ok && data?.ok === true) return { ok: true };
  if (r.status === 400) return { ok: false, error: detail ?? 'Refused.' };
  throw new Error(detail ?? `The trigger word check failed (${r.status}).`);
}
