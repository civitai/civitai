import { begin, idle, settle, type KeepLast } from './keep-last';

/**
 * Hold the last answer while the next one loads.
 *
 * 🔴 This is the ONE sanctioned exception to "derive the promise; never fetch in `$effect` and assign
 * to `$state`" (see the app standard). Use `$derived` + `{#await}` everywhere else — it is right for a
 * panel with nothing to show yet, and this is not that case.
 *
 * It exists because `{#await}` has no concept of a previous answer: any refetch re-enters the pending
 * branch, so paging a list replaces the rows the operator was reading with a spinner, and re-filtering
 * takes the control they were using with it. Against a 1.5B-row table that is seconds of empty screen
 * traded for data already on it.
 *
 * The standard names three failure modes for this shape, and each is closed:
 *
 *   **Stuck spinner** — `settle` clears `loading` on both paths, so no outcome leaves it set.
 *   **Re-run loop** — the effect writes `state` and reads none of it; it reads only `source()`, whose
 *     own dependencies decide when to re-run.
 *   **A stale response landing on a newer request** — every run takes a ticket, and `settle` discards a
 *     response whose ticket is no longer current.
 *
 * The decisions are in `keep-last.ts`, which is plain TypeScript and tested; this file is the plumbing.
 */
export function keepLast<T>(source: () => Promise<T> | null) {
  let state = $state<KeepLast<T>>(idle<T>());

  $effect(() => {
    const promise = source();
    if (!promise) return;

    state = begin(state);
    const ticket = state.current;

    promise.then(
      (value) => (state = settle(state, ticket, { ok: true, value })),
      () => (state = settle(state, ticket, { ok: false }))
    );
  });

  return {
    /** The last successful answer, kept across refetches. Null only before the first one arrives. */
    get value() {
      return state.value;
    },
    /** A request is in flight. Can be true alongside a `value` — that is the whole point. */
    get loading() {
      return state.loading;
    },
    /** The most recent request failed. `value`, if any, is the last good answer and still shown. */
    get failed() {
      return state.failed;
    },
  };
}
