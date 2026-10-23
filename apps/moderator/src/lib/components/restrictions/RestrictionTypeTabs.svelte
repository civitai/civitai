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
    compact = false,
  }: {
    types: readonly RestrictionType[];
    current: RestrictionType;
    fallbackType: RestrictionType;
    /** Absent while the counts are unavailable: a placeholder 0 reads as "nothing to review". */
    counts?: Partial<Record<RestrictionType, number>>;
    /** A segmented switch for the top of a queue column, as `TriageTabs`' `compact`. */
    compact?: boolean;
  } = $props();

  const HINTS: Record<RestrictionType, string> = {
    generation: 'prompt blocked by the word list',
    'bot-account': 'flagged as automated use',
    scam: 'flagged as a scam',
  };

  // The open item and the page index the result set being replaced.
  const hrefFor = (type: RestrictionType) =>
    urlWith(page.url, {
      type: type === fallbackType ? null : type,
      page: null,
      selected: null,
    });
</script>

{#snippet badge(count: number | undefined, active: boolean)}
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
{/snippet}

{#if compact}
  <!-- At the top of the list column, as `TriageTabs`' compact switch: the hint is on hover. -->
  <nav
    class="grid auto-cols-fr grid-flow-col gap-0.5 rounded-md border border-dark-4 bg-dark-8 p-0.5"
    aria-label="Restriction type"
  >
    {#each types as type (type)}
      {@const active = type === current}
      <a
        href={hrefFor(type)}
        title={HINTS[type]}
        data-sveltekit-noscroll
        data-sveltekit-keepfocus
        aria-current={active ? 'page' : undefined}
        class={cn(
          'flex min-w-0 flex-col items-center justify-center gap-0.5 rounded px-1.5 py-1 text-[13px] leading-tight',
          active ? 'bg-dark-5 font-semibold text-white' : 'font-medium text-dark-0 hover:text-white'
        )}
      >
        <span class="whitespace-nowrap">{RESTRICTION_TYPE_LABELS[type]}</span>
        {@render badge(counts?.[type], active)}
      </a>
    {/each}
  </nav>
{:else}
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
          '-mb-px flex flex-col gap-0.5 border-b-2 px-3 pt-1.5 pb-2.5',
          active
            ? 'border-blue-500 font-semibold text-white'
            : 'border-transparent font-medium text-dark-0 hover:text-white'
        )}
      >
        <span class="flex items-center gap-2 text-sm">
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
        </span>
        <span class="text-[11px] font-normal text-dark-2">{HINTS[type]}</span>
      </a>
    {/each}
  </nav>
{/if}
