<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { RESTRICTION_TYPE_LABELS, type RestrictionType } from '$lib/restriction-types';
  import { urlWith } from '$lib/url';

  let {
    types,
    current,
    fallbackType,
    counts,
  }: {
    types: readonly RestrictionType[];
    current: RestrictionType;
    fallbackType: RestrictionType;
    /** Absent while the counts are unavailable: a placeholder 0 reads as "nothing to review". */
    counts?: Partial<Record<RestrictionType, number>>;
  } = $props();

  // The open item and the page index the result set being replaced.
  const hrefFor = (type: RestrictionType) =>
    urlWith(page.url, {
      type: type === fallbackType ? null : type,
      page: null,
      selected: null,
    });
</script>

<nav class="flex items-end gap-1 border-b border-dark-4 px-6 pt-3.5" aria-label="Restriction type">
  {#each types as type (type)}
    {@const active = type === current}
    {@const count = counts?.[type]}
    <a
      href={hrefFor(type)}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
      aria-current={active ? 'page' : undefined}
      class={cn(
        '-mb-px flex items-center gap-2 border-b-2 px-3 pt-1.5 pb-2.5 text-sm',
        active
          ? 'border-blue-500 font-semibold text-white'
          : 'border-transparent font-medium text-dark-0 hover:text-white'
      )}
    >
      {RESTRICTION_TYPE_LABELS[type]}
      {#if count !== undefined}
        <span
          class={cn(
            'rounded-lg px-[7px] py-px text-[11px] font-semibold tabular-nums',
            active ? 'bg-blue-500 text-white' : 'bg-dark-6 text-dark-0'
          )}
        >
          {num(count)}
        </span>
      {/if}
    </a>
  {/each}
</nav>
