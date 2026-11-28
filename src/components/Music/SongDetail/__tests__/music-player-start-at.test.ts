import { describe, expect, it } from 'vitest';
import type { MusicTrack } from '~/store/music-player.store';
import { createMusicPlayerStore } from '~/store/music-player.store';

const track = (id: number, durationSec = 200): MusicTrack => ({
  id,
  url: `song-${id}.mp3`,
  title: `Song ${id}`,
  durationSec,
  creator: { id: 100 + id, username: `artist${id}` },
});
const [a, b] = [track(1), track(2)];

// The song detail view starts a song at a lyric line's time instead of seeking after the switch.
describe('playFromList with a start position', () => {
  it('starts the song there, held inside the song, and from 0 without one', () => {
    const { getState: get } = createMusicPlayerStore();
    get().playFromList({ name: 'Feed', tracks: [a, b], index: 0, startAtSec: 42 });
    expect(get().current?.id).toBe(a.id);
    expect(get().playing).toBe(true);
    expect(get().playback?.startAtSec).toBe(42);

    get().playFromList({ name: 'Feed', tracks: [a, b], index: 1, startAtSec: 9999 });
    expect(get().playback?.startAtSec).toBe(b.durationSec);

    get().playFromList({ name: 'Feed', tracks: [a, b], index: 0 });
    expect(get().playback?.startAtSec).toBe(0);
  });
});
