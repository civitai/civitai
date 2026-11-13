import { useEffect, useRef } from 'react';
import { claimPlayback } from '~/components/Audio/exclusive-playback';
import { resolveEdgeUrl } from '~/client-utils/edge-url';
import type { MusicPlayerState } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { clampPlaybackTime } from '~/utils/audio-player';

let activeElement: HTMLAudioElement | null = null;

/** Moves the global player to `time`, held inside the song. */
export function seekMusicPlayer(time: number) {
  const media = activeElement;
  if (!media) return;
  const next = clampPlaybackTime(time, useMusicPlayheadStore.getState().duration);
  media.currentTime = next;
  useMusicPlayheadStore.setState({ currentTime: next });
}

function startPlaying(media: HTMLAudioElement) {
  media.play().catch((error: unknown) => {
    // A newer source or a pause interrupted this play; the newer call is the one that counts.
    if (error instanceof DOMException && error.name === 'AbortError') return;
    // Refused (no user gesture) or unplayable: a failed load also fires `error` on the element.
    if (useMusicPlayerStore.getState().playing) useMusicPlayerStore.getState().pause();
  });
}

/**
 * Brings the element in line with what changed in the store; `prev` is undefined on mount. Play and
 * pause are asserted only when `playing` or the playback changed: the element's own `play`/`pause`
 * events arrive a task after the call, so re-asserting on every other change (the playhead, ~4 a
 * second) would fight them in a loop.
 */
function apply(media: HTMLAudioElement, state: MusicPlayerState, prev?: MusicPlayerState) {
  const track = state.current;
  if (!track) {
    if (prev?.current || media.hasAttribute('src')) {
      media.pause();
      media.removeAttribute('src');
      media.load();
      useMusicPlayheadStore.setState({ currentTime: 0, duration: 0 });
    }
    return;
  }

  const started = !prev || state.playback?.playbackId !== prev.playback?.playbackId;
  if (started) {
    // 0, or where a song restored after a reload was; set before the load, it is where it starts.
    const startAt = state.playback?.startAtSec ?? 0;
    const url = resolveEdgeUrl(track.url, { type: 'audio' }).url;
    if (media.getAttribute('src') !== url) media.src = url;
    if (startAt || media.currentTime) media.currentTime = startAt;
    useMusicPlayheadStore.setState({ currentTime: startAt, duration: track.durationSec });
  }

  if (started || state.playing !== prev?.playing) {
    if (state.playing && media.paused) startPlaying(media);
    else if (!state.playing && !media.paused) media.pause();
  }

  if (!prev || state.volume !== prev.volume) media.volume = state.volume;
  if (!prev || state.muted !== prev.muted) media.muted = state.muted;
}

const pauseThroughStore = () => useMusicPlayerStore.getState().pause();

/**
 * The global player's one `<audio>` element. It follows the player store through a synchronous
 * subscription, so a play started by a click calls `play()` inside that click (browsers refuse
 * playback outside a user gesture). Mount it once, where it survives client navigation.
 */
export function MusicPlayerAudio() {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    activeElement = media;
    apply(media, useMusicPlayerStore.getState());
    const unsubscribe = useMusicPlayerStore.subscribe((state, prev) => apply(media, state, prev));
    return () => {
      unsubscribe();
      if (activeElement === media) activeElement = null;
      media.pause();
    };
  }, []);

  const store = useMusicPlayerStore.getState;
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio
      ref={ref}
      preload="auto"
      className="hidden"
      // The events arrive a task late: act only on what the element is doing now.
      onPlay={(e) => {
        if (e.currentTarget.paused) return;
        claimPlayback(e.currentTarget, pauseThroughStore);
        if (!store().playing) store().resume();
      }}
      onPause={(e) => {
        const media = e.currentTarget;
        // At the end, `ended` follows and decides what plays next.
        if (media.paused && !media.ended && store().playing) store().pause();
      }}
      onEnded={() => store().ended()}
      onTimeUpdate={(e) => {
        const { currentTime } = e.currentTarget;
        useMusicPlayheadStore.setState({ currentTime });
        store().reportTime(currentTime);
      }}
      onLoadedMetadata={(e) => {
        const { duration } = e.currentTarget;
        if (!isFinite(duration) || duration <= 0) return;
        useMusicPlayheadStore.setState({ duration });
        store().reportDuration(duration);
      }}
      onError={() => {
        if (store().current) store().markError();
      }}
    />
  );
}
