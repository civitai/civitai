import { browser } from '$lib/host';
import { spendOrder } from '$lib/mature-charge';

// The global Buzz spend mode: the paid account — yellow (purchased) or green (membership) — and whether
// Blue (free) spends ahead of it. It drives two things app-wide: the `--color-buzz` theme var (so every
// `buzz`-colored surface recolors at once) and the submit `currencies`.
export type BuzzMode = 'yellow' | 'green';

const KEY = 'ts-buzz-mode';
const BLUE_FIRST_KEY = 'ts-buzz-blue-first';

function stored(): BuzzMode {
  if (!browser) return 'yellow';
  return localStorage.getItem(KEY) === 'green' ? 'green' : 'yellow';
}

// Module-scope `$state`, safe across SSR requests only because `stored()` returns a user-independent
// constant on the server and the mutators below run in the browser only. Never seed this from a
// cookie/session or call `set()` in a server load — that would leak one user's choice into another's render.
let mode = $state<BuzzMode>(stored());
let locked = $state(false);
// Default on: only an explicit opt-out ('0') skips Blue.
let blueFirst = $state(!browser || localStorage.getItem(BLUE_FIRST_KEY) !== '0');

function applyClass(next: BuzzMode) {
  if (browser) document.documentElement.classList.toggle('buzz-green', next === 'green');
}
applyClass(mode);

export const buzzMode = {
  get value(): BuzzMode {
    return mode;
  },
  /** True when the host dictates the mode (embed on a green/yellow domain) — the paid-account picker hides. */
  get locked(): boolean {
    return locked;
  },
  set(next: BuzzMode) {
    if (locked) return;
    mode = next;
    if (browser) localStorage.setItem(KEY, next);
    applyClass(next);
  },
  /** Host-dictated mode: applied but never persisted, so it can't leak into the standalone's
   *  stored preference (`set` writes localStorage; this must not). Deliberately one-shot for the
   *  element's lifetime — a host re-wire without `config.buzzMode` does not unlock. */
  lock(next: BuzzMode) {
    mode = next;
    locked = true;
    applyClass(next);
  },
  toggle() {
    this.set(mode === 'yellow' ? 'green' : 'yellow');
  },
  /** Blue spends before the paid account. The user's choice even when the host locks the paid account. */
  get blueFirst(): boolean {
    return blueFirst;
  },
  setBlueFirst(next: boolean) {
    blueFirst = next;
    if (browser) localStorage.setItem(BLUE_FIRST_KEY, next ? '1' : '0');
  },
  get currencies(): string[] {
    return spendOrder(mode, blueFirst);
  },
};
