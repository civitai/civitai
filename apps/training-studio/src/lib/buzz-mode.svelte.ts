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

function applyClass(next: BuzzMode) {
  if (browser) document.documentElement.classList.toggle('buzz-green', next === 'green');
}
applyClass(mode);

export const buzzMode = {
  get value(): BuzzMode {
    return mode;
  },
  set(next: BuzzMode) {
    mode = next;
    if (browser) localStorage.setItem(KEY, next);
    applyClass(next);
  },
  toggle() {
    this.set(mode === 'yellow' ? 'green' : 'yellow');
  },
  /** Accounts to charge, in priority order: the chosen primary, then blue as fallback. */
  get currencies(): string[] {
    return [mode, 'blue'];
  },
};
