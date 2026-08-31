import { invalidateAll } from '$app/navigation';
import { refetching } from '$lib/state/refetching.svelte';

const ONE_YEAR = 60 * 60 * 24 * 365;

// A UI setting whose source of truth is a host-only cookie the server reads into `data`. `set()` writes the cookie,
// re-runs the loads (invalidateAll) with a progress indicator, and optimistically shows the new value until the
// reload lands — so the control never lags a round-trip behind the click.
//
// Reusable for any server-affecting setting (period, filters, …): construct with the cookie name, a getter for the
// server (canonical) value, and an encoder; pair it with a matching read in the loaders. Client prefs that DON'T
// touch the server belong in the localStorage `persisted()` store instead.
export class CookieState<T> {
  #name: string;
  #canonical: () => T;
  #encode: (value: T) => string;
  #maxAge: number;
  // Wrapped so a legitimately-null value is distinguishable from "no change pending".
  #pending = $state<{ value: T } | null>(null);

  constructor(
    name: string,
    canonical: () => T,
    options: { encode?: (value: T) => string; maxAge?: number } = {}
  ) {
    this.#name = name;
    this.#canonical = canonical;
    this.#encode = options.encode ?? String;
    this.#maxAge = options.maxAge ?? ONE_YEAR;
  }

  // Optimistic while a change is in flight, otherwise the server value from `data`.
  get value(): T {
    return this.#pending ? this.#pending.value : this.#canonical();
  }

  async set(value: T): Promise<void> {
    this.#pending = { value };
    // No Domain attribute → host-only cookie, scoped to this subdomain only.
    document.cookie = `${this.#name}=${this.#encode(value)}; path=/; max-age=${
      this.#maxAge
    }; samesite=lax`;
    refetching.begin();
    try {
      await invalidateAll();
    } finally {
      refetching.end();
      this.#pending = null;
    }
  }
}
