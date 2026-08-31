import { browser } from '$app/environment';

// A UI preference backed by localStorage — client-only (never touches the server), browser-guarded, JSON
// (de)serialized, fail-open. Svelte 5 shared state: read `x.value` reactively, write `x.set(v)` (or `x.value = v`).
// Keys are namespaced under `cs:`. For state that must drive SSR loads, use CookieState instead.
function readStored<T>(key: string, initial: T): T {
  if (!browser) return initial;
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? (JSON.parse(raw) as T) : initial;
  } catch {
    return initial;
  }
}

export class LocalState<T> {
  #key: string;
  #value = $state(undefined as T);

  constructor(key: string, initial: T) {
    this.#key = `cs:${key}`;
    this.#value = readStored(this.#key, initial);
  }

  get value(): T {
    return this.#value;
  }
  set value(v: T) {
    this.#value = v;
    if (browser) {
      try {
        localStorage.setItem(this.#key, JSON.stringify(v));
      } catch {
        /* private mode / storage disabled — the preference just won't persist */
      }
    }
  }
  set(v: T) {
    this.value = v;
  }
  update(fn: (v: T) => T) {
    this.value = fn(this.#value);
  }
}
