import { playedFraction, WATCHED_FRACTION } from '@civitai/shared/held-media';

const CAPTURE = { capture: true };
type Played = Parameters<typeof playedFraction>[0];

/**
 * `use:shown`: calls `onshown` once the media inside `node` is on screen: an image whose pixels
 * loaded, or a video WATCHED_FRACTION played. Listened for in the capture phase, since media events
 * do not bubble.
 */
export function shown(node: EventTarget, options: { video: boolean; onshown: () => void }) {
  let done = false;
  const report = () => {
    if (done) return;
    done = true;
    options.onshown();
  };
  const onLoad = (e: Event) => {
    const target = e.target as { naturalWidth?: number } | null;
    if (!options.video && (target?.naturalWidth ?? 0) > 0) report();
  };
  const onProgress = (e: Event) => {
    const target = e.target as Partial<Played> | null;
    if (options.video && target?.played && playedFraction(target as Played) >= WATCHED_FRACTION)
      report();
  };
  const progress = ['timeupdate', 'pause', 'ended'];
  node.addEventListener('load', onLoad, CAPTURE);
  for (const type of progress) node.addEventListener(type, onProgress, CAPTURE);
  return {
    destroy() {
      node.removeEventListener('load', onLoad, CAPTURE);
      for (const type of progress) node.removeEventListener(type, onProgress, CAPTURE);
    },
  };
}
