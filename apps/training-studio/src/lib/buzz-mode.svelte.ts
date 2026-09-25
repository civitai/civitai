import { browser } from '$lib/host';

// The global Buzz spend mode. Blue (generation) is ALWAYS available; this toggle picks the primary
// account — yellow (purchased) or green (membership). It drives two things app-wide: the `--color-buzz`
// theme var (so every `buzz`-colored surface recolors at once) and the submit `currencies`.
export type BuzzMode = 'yellow' | 'green';

const KEY = 'ts-buzz-mode';

function stored(): BuzzMode {
  if (!browser) return 'yellow';
  return localStorage.getItem(KEY) === 'green' ? 'green' : 'yellow';
}

// Module-scope `$state`, safe across SSR requests only because `stored()` returns a user-independent
// constant on the server and the mutators below run in the browser only. Never seed this from a
// cookie/session or call `set()` in a server load — that would leak one user's choice into another's render.
let mode = $state<BuzzMode>(stored());
let locked = $state(false);

function applyClass(next: BuzzMode) {
  if (browser) document.documentElement.classList.toggle('buzz-green', next === 'green');
}
applyClass(mode);

export const buzzMode = {
  get value(): BuzzMode {
    return mode;
  },
  /** True when the host dictates the mode (embed on a green/yellow domain) — toggle surfaces hide. */
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
  /** Accounts to charge, in priority order: Blue (the free sub-currency) always spends first —
   *  that's why it isn't offered in the picker — then the chosen yellow/green. */
  get currencies(): string[] {
    return ['blue', mode];
  },
};
