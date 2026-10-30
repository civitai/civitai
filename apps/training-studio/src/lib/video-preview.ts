/** Hover-to-preview handlers for tile `<video>`s — play on enter, rewind on leave — plus the attrs
 *  every tile video needs (`muted loop playsinline preload="metadata"`; without the preload some
 *  browsers render a black box instead of the first frame). Full playback with controls belongs to
 *  the fullscreen viewers. One definition: a tile video that misses these reads as "videos don't
 *  play", which is exactly how it got reported. */
export function playOnHover(e: Event) {
  (e.currentTarget as HTMLVideoElement).play().catch(() => {});
}

export function resetOnLeave(e: Event) {
  const v = e.currentTarget as HTMLVideoElement;
  v.pause();
  v.currentTime = 0;
}
