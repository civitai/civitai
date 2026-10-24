import { browser } from '$app/environment';

// One clock for everything that renders an age, so a page left open keeps ageing. App-lifetime: the
// interval is never cleared, and there is only ever one.
const clock = $state({ now: Date.now() });
let started = false;

export function minuteClock(): { readonly now: number } {
  if (browser && !started) {
    started = true;
    setInterval(() => (clock.now = Date.now()), 60_000);
  }
  return clock;
}
