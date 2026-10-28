<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import { toggleHref, type FilterOption } from '$lib/tickets/filters';

  let {
    param,
    label,
    options,
    drop,
    collapsible,
  }: {
    /** The repeated URL param this row writes. */
    param: string;
    label: string;
    options: FilterOption[];
    /** Params that index the old result set (page, open ticket) and go with any change. */
    drop: readonly string[];
    /** Folds the chips under their label, for a filter with many values. */
    collapsible: boolean;
  } = $props();

  const selected = $derived(options.filter((o) => o.active).length);
</script>

{#snippet chips()}
  <div class="flex flex-wrap items-center gap-1">
    {#each options as option (option.value)}
      <a
        href={toggleHref(page.url, param, option.value, drop)}
        data-sveltekit-noscroll
        data-sveltekit-keepfocus
        aria-current={option.active ? 'true' : undefined}
        class={cn(
          'inline-flex max-w-full items-center rounded-full border px-1.5 py-[3px] text-xs leading-[15px] whitespace-nowrap transition-colors',
          option.active
            ? 'border-dark-5 bg-dark-5 text-white'
            : 'border-dark-4 text-dark-1 hover:bg-dark-5 hover:text-white'
        )}
      >
        <span class="truncate">{option.label}</span>
        <span class={cn('ml-[3px] tabular-nums', option.active ? 'text-dark-0' : 'text-dark-2')}
          >{option.count}</span
        >
      </a>
    {/each}
  </div>
{/snippet}

{#if options.length > 0}
  {#if collapsible}
    <details class="group" open={selected > 0}>
      <summary
        class="inline-flex cursor-pointer list-none items-center gap-1 rounded px-1 py-[3px] text-xs text-dark-2 select-none hover:text-white"
      >
        <span class="transition-transform group-open:rotate-90" aria-hidden="true">›</span>
        {label}
        {#if selected > 0}<span class="text-blue-300">({selected})</span>{/if}
      </summary>
      <div class="mt-1">{@render chips()}</div>
    </details>
  {:else}
    <div class="flex flex-col gap-1">
      <span class="px-1 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase"
        >{label}</span
      >
      {@render chips()}
    </div>
  {/if}
{/if}
