<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { IconChevronDown } from '@tabler/icons-svelte';
  import { cn } from '@civitai/ui/utils.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import { optionText, selectionHref, triggerText, type FilterOption } from '$lib/tickets/filters';

  let {
    param,
    label,
    options,
    drop,
  }: {
    /** The repeated URL param this menu writes. */
    param: string;
    label: string;
    options: FilterOption[];
    /** Params that index the old result set (page, open ticket) and go with any change. */
    drop: readonly string[];
  } = $props();

  const uid = $props.id();
  const selected = $derived(options.filter((o) => o.active).map((o) => o.value));

  // The ticks are a draft until the menu closes: one navigation per menu, not one per checkbox.
  let draft = $state<string[]>([]);

  function openChange(open: boolean) {
    if (open) {
      draft = [...selected];
      return;
    }
    const changed = draft.length !== selected.length || draft.some((v) => !selected.includes(v));
    if (changed) {
      void goto(selectionHref(page.url, param, draft, drop), { noScroll: true, keepFocus: true });
    }
  }

  function tick(value: string, on: boolean) {
    draft = on ? [...draft, value] : draft.filter((v) => v !== value);
  }
</script>

<Popover.Root onOpenChange={openChange}>
  <Popover.Trigger
    class={cn(
      'inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
      selected.length > 0
        ? 'border-blue-500 text-white'
        : 'border-dark-4 text-dark-1 hover:bg-dark-5 hover:text-white'
    )}
  >
    {triggerText(label, selected.length)}
    <IconChevronDown class="size-3.5 text-dark-2" aria-hidden="true" />
  </Popover.Trigger>
  <Popover.Content align="start" class="max-h-80 w-64 gap-1 overflow-y-auto p-1.5">
    {#each options as option (option.value)}
      {@const id = `${uid}-${option.value}`}
      <label
        for={id}
        class={cn(
          'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-dark-5',
          option.count === 0 && !draft.includes(option.value) && 'opacity-50'
        )}
      >
        <Checkbox
          {id}
          checked={draft.includes(option.value)}
          onCheckedChange={(on) => tick(option.value, on)}
        />
        <span class="min-w-0 flex-1 truncate">{option.label}</span>
        <span class="text-xs text-dark-2 tabular-nums" aria-hidden="true">{option.count}</span>
        <span class="sr-only">{optionText(option)}</span>
      </label>
    {:else}
      <p class="m-0 px-1.5 py-1 text-xs text-dark-2">No values in this view.</p>
    {/each}
    <div class="mt-1 flex items-center justify-between gap-2 border-t border-dark-4 px-1 pt-1.5">
      <Button size="sm" variant="ghost" disabled={draft.length === 0} onclick={() => (draft = [])}>
        Clear
      </Button>
      <Popover.Close>
        {#snippet child({ props })}
          <Button size="sm" {...props}>Apply</Button>
        {/snippet}
      </Popover.Close>
    </div>
  </Popover.Content>
</Popover.Root>
