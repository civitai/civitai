import type { ChipGroup } from '$lib/components/triage/TriageFilterChips.svelte';

/** The Appeals, Held and Disputes tabs' sort select. */
export const oldestNewestSort = (active: 'oldest' | 'newest') =>
  ({
    key: 'sort',
    label: 'Sort',
    values: ['oldest', 'newest'] as const,
    labels: { oldest: 'Oldest first', newest: 'Newest first' },
    active,
    defaultValue: 'oldest',
    pill: true,
  } satisfies ChipGroup);
