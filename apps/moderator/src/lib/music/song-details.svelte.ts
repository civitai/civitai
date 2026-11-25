import { browser } from '$app/environment';
import { songDetailsUrl, type AudioTab, type SongDetails } from '$lib/audio-review';
import { fetchJson } from '$lib/fetch-json';
import { SSR_PENDING } from '$lib/ssr-pending';

/** The open song's side-card details for `tab`, read in the browser only, once per song. `id` returns null
 *  for a song that must not be read: withheld from this moderator, or gone. */
export function songDetails(id: () => number | null, tab: AudioTab) {
  const details = $derived.by(() => {
    const songId = id();
    return browser && songId != null
      ? fetchJson<SongDetails>(songDetailsUrl(songId, tab))
      : (SSR_PENDING as Promise<SongDetails>);
  });
  return {
    get current() {
      return details;
    },
  };
}
