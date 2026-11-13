let current: HTMLMediaElement | null = null;

/**
 * One song player sounds at a time: call from a song player's `play` event (the global player and
 * the inline song players do) and the one playing before it pauses. Videos do not take part.
 */
export function claimPlayback(media: HTMLMediaElement) {
  const before = current;
  current = media;
  if (before && before !== media && before.isConnected && !before.paused) before.pause();
}
