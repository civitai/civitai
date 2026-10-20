import type { CsamHoldImages } from '$lib/server/csam-holds.service';

/** The pictures of one hold, or null when it has none or they could not be read: the pane just omits them. */
export async function fetchHoldImages(
  holdId: number,
  fetcher: typeof fetch = fetch
): Promise<CsamHoldImages | null> {
  try {
    const res = await fetcher(`/csam/text-holds/images/${holdId}`);
    if (!res.ok) return null;
    return ((await res.json()) as { images: CsamHoldImages | null }).images;
  } catch {
    return null;
  }
}
