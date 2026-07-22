import { writable, type Writable } from 'svelte/store';
import { browser } from '$app/environment';

// A writable store backed by localStorage — the single place we do browser-guarding, JSON (de)serialization, and
// fail-open error handling, so adding a new persisted UI preference is a one-liner:
//   export const myToggle = persisted('my-toggle', false);
// Keys are namespaced under `cs:` (creator-studio). SSR-safe: on the server it just holds `initial`.
export function persisted<T>(key: string, initial: T): Writable<T> {
  const storageKey = `cs:${key}`;
  let start = initial;
  if (browser) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw != null) start = JSON.parse(raw) as T;
    } catch {
      /* corrupt / unavailable — fall back to the initial value */
    }
  }
  const store = writable<T>(start);
  if (browser) {
    store.subscribe((v) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(v));
      } catch {
        /* private mode / storage disabled — the preference just won't persist */
      }
    });
  }
  return store;
}
