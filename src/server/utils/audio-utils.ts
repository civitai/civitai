import { useMemo, useState } from 'react';
/**
 * Creates an audio controller for a base64-encoded audio file.
 * @param base64Audio - The base64-encoded audio string.
 * @returns An object with methods to control audio playback and set onDone callback.
 */
let audio: HTMLAudioElement | null = null;
export function useBase64Audio(base64Audio: string, autoplay = false) {
  const [playing, setPlaying] = useState(false);
  const controls = useMemo(() => {
    if (!base64Audio || base64Audio.length === 0 || typeof window === 'undefined') return {};
    if (audio) {
      console.log('existing');
      audio.pause();
    }
    audio = new Audio('data:audio/mp3;base64,' + base64Audio);
    audio.autoplay = autoplay;
    audio.onplay = () => setPlaying(true);
    audio.onpause = () => setPlaying(false);
    audio.onended = () => setPlaying(false);

    return {
      play: () => audio!.play(),
      pause: () => audio!.pause(),
      stop: () => {
        audio!.pause();
        audio!.currentTime = 0;
      },
    };
  }, [base64Audio]);

  return {
    play: () => undefined,
    pause: () => undefined,
    stop: () => undefined,
    ...controls,
    playing,
  };
}
