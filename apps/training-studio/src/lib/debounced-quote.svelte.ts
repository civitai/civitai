/**
 * The sanctioned exception to derive-the-promise: a quote driven by keystrokes must debounce, and
 * its consumers need the RESOLVED number (to sum across runs, to gate submit) — not a promise. The
 * staleness that rule guards against is closed here instead: the value blanks SYNCHRONOUSLY when
 * the key changes (a price for the previous config must never stay on screen with submit enabled)
 * and only the newest burst may write. One definition — ReviewStep's per-run quotes and
 * RunDetail's train-further quote are the same machine, and a stale-write fix must not land in one
 * copy and not the other.
 *
 * The key goes through a `$derived` before the effect reads it — that is what makes value-equal
 * recomputes (e.g. a preset re-click rebuilding params with identical numbers) skip the effect:
 * a derived only notifies dependents when its value changes under `===`, while an effect reading
 * `getKey()` directly would re-arm on every dependency write. `null` = inactive: stay blank,
 * fetch nothing.
 *
 * The FETCHER owns error mapping — it must catch and encode failure in the value (a rejection is
 * swallowed here and leaves the value blank, which reads as stuck-pending).
 */
export function debouncedQuote<T>(
  getKey: () => string | null,
  fetch: () => Promise<T>,
  delayMs = 400
) {
  let value = $state<T | undefined>(undefined);
  let retryTick = $state(0);
  let seq = 0;
  const derivedKey = $derived(getKey());
  $effect(() => {
    void retryTick;
    const key = derivedKey;
    const mine = ++seq;
    value = undefined;
    if (key === null) return;
    const timer = setTimeout(() => {
      fetch().then(
        (v) => {
          if (mine === seq) value = v;
        },
        () => undefined
      );
    }, delayMs);
    return () => clearTimeout(timer);
  });
  return {
    /** `undefined` while blank / in-flight / inactive; the fetcher's resolved value afterwards. */
    get value() {
      return value;
    },
    /** Re-fire the current key's fetch (for a failure the fetcher encoded in the value). */
    retry() {
      retryTick++;
    },
  };
}
