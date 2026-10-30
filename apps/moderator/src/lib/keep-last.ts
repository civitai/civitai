/**
 * The decision half of `keep-last.svelte.ts`, as plain functions so it can be tested.
 *
 * The rune file is plumbing — `$state` fields and an `$effect` that calls these. Everything that can be
 * wrong lives here: which settled response is allowed to write, and what a failure is allowed to erase.
 * The app's vitest project runs without the Svelte plugin, so a `.svelte.ts` cannot be imported by a
 * test at all; splitting it is what makes the guard checkable rather than merely asserted in a comment.
 */

export type KeepLast<T> = {
  /** The last successful answer. Kept across refetches, and across failures. */
  value: T | null;
  loading: boolean;
  failed: boolean;
  /** The ticket of the most recent request. A response holding any other ticket is stale. */
  current: number;
};

export const idle = <T>(): KeepLast<T> => ({
  value: null,
  loading: false,
  failed: false,
  current: 0,
});

/** A new request starts: take the next ticket, and clear the previous failure without clearing data. */
export const begin = <T>(state: KeepLast<T>): KeepLast<T> => ({
  ...state,
  loading: true,
  failed: false,
  current: state.current + 1,
});

/**
 * A request settles.
 *
 * Ignored unless its ticket is still the current one. Without that, a slow request for the PREVIOUS
 * filter lands after a fast one for the current filter and replaces it — leaving rows on screen that
 * answer a question the controls no longer show, with nothing to indicate it.
 *
 * A failure sets `failed` and keeps `value`: blanking the last good answer turns a transient error into
 * apparent absence, and on a moderation screen absence is a finding.
 */
export const settle = <T>(
  state: KeepLast<T>,
  ticket: number,
  result: { ok: true; value: T } | { ok: false }
): KeepLast<T> => {
  if (ticket !== state.current) return state;
  return result.ok
    ? { ...state, value: result.value, loading: false, failed: false }
    : { ...state, loading: false, failed: true };
};
