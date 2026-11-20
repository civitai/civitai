/**
 * The current time, `null` until mount so a reset time is only ever drawn in the viewer's zone,
 * never the server's. Ticks so "+1 at 3:40 PM" turns into "available now" on a page left open.
 * Call during component init.
 */
export function nowTick(intervalMs = 30_000) {
  let now = $state<number | null>(null);
  $effect(() => {
    now = Date.now();
    const tick = setInterval(() => (now = Date.now()), intervalMs);
    return () => clearInterval(tick);
  });
  return {
    get current() {
      return now;
    },
  };
}
