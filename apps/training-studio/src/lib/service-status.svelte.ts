import { backend, browser } from '$lib/host';
import type { TrainingServiceStatus } from '$lib/service-status-core';

// Module-scope `$state`, written only in the browser — the status is the same for every user, but
// keeping SSR on null matches buzz-balance.svelte.ts and keeps the banner client-rendered in both hosts.
let status = $state<TrainingServiceStatus | null>(null);

export const serviceStatus = {
  /** Null until read, or when the host can't provide one — treated as available, no banner. */
  get value(): TrainingServiceStatus | null {
    return status;
  },
  async refresh() {
    if (!browser) return;
    try {
      status = await backend().getServiceStatus();
    } catch {
      // Keep the last known value; the server still refuses a disabled submit.
    }
  },
};
