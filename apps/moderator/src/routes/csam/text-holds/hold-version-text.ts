import type { VersionTextHitText } from '$lib/csam-holds/version-text-hits';

const loaded = new Map<number, Promise<VersionTextHitText[]>>();

/** Fetched once per hold, on request; a failure is not kept, so the next try asks again. */
export function fetchHoldVersionTexts(holdId: number): Promise<VersionTextHitText[]> {
  const cached = loaded.get(holdId);
  if (cached) return cached;
  const request = fetch(`/api/csam-hold-version-text/${holdId}`)
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<{ hits: VersionTextHitText[] }>;
    })
    .then(({ hits }) => hits)
    .catch((err) => {
      loaded.delete(holdId);
      throw err;
    });
  loaded.set(holdId, request);
  return request;
}
