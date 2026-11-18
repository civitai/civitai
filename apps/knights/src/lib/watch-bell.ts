/** `watch` names the Watch (`DailyStatus.watch`): the bell re-arms only for a new one. */
export type WatchReading = { value: number; max: number; watch: string };

const complete = ({ value, max }: WatchReading) => max > 0 && value >= max;

/**
 * Rings once per Watch, for a Watch completed while the page is open. A refused vote un-counts the completing vote, so the
 * count can cross the line twice; never for the first read.
 */
export function watchBell(start: WatchReading): (now: WatchReading) => boolean {
  let watch = start.watch;
  let rung = complete(start);
  return (now) => {
    if (now.watch !== watch) {
      watch = now.watch;
      rung = complete(now);
      return false;
    }
    if (rung || !complete(now)) return false;
    rung = true;
    return true;
  };
}
