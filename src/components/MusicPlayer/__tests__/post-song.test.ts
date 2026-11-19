import { afterEach, describe, expect, it } from 'vitest';
import type { SongImage } from '~/components/MusicPlayer/PostSong';
import { playSongFromList, postSongList } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerStore } from '~/store/music-player.store';

const song = (id: number): SongImage => ({
  id,
  url: `song-${id}.mp3`,
  metadata: { title: `Song ${id}`, duration: 120 },
  user: { id: 7, username: 'artist' },
});
const [first, second, third] = [1, 2, 3].map(song);
const state = useMusicPlayerStore.getState;
const upNext = () => state().list.map((t) => t.id);

afterEach(() => state().close());

describe('playing a song on a post', () => {
  const post = postSongList('Two songs', [first, second]);

  it('puts the songs after it in Up next', () => {
    playSongFromList(first, post);
    expect(state().current?.id).toBe(first.id);
    expect(upNext()).toEqual([second.id]);
    expect(state().listName).toBe('Two songs');
  });

  it("puts the post's earlier songs in Up next when it is the last one", () => {
    playSongFromList(second, post);
    expect(state().current?.id).toBe(second.id);
    expect(upNext()).toEqual([first.id]);
  });

  it('continues from the song after it, then from the top of the post', () => {
    playSongFromList(second, postSongList('Two songs', [first, second, third]));
    expect(upNext()).toEqual([third.id, first.id]);
  });
});

describe('playing a song from a feed', () => {
  it('puts only the songs after it in Up next', () => {
    playSongFromList(second, { name: 'All music', songs: [first, second, third] });
    expect(upNext()).toEqual([third.id]);
  });
});
