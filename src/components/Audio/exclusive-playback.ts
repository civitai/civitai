let current: { media: HTMLMediaElement; pause: () => void } | null = null;

/**
 * One song player sounds at a time: call from a song player's `play` event (the global player and
 * the inline song players do) and the one playing before it pauses. A player whose element follows
 * a store passes `pause` so it is stopped through that store rather than behind its back. Videos
 * do not take part.
 */
export function claimPlayback(media: HTMLMediaElement, pause = () => media.pause()) {
  const before = current;
  current = { media, pause };
  if (before && before.media !== media && before.media.isConnected && !before.media.paused)
    before.pause();
}
