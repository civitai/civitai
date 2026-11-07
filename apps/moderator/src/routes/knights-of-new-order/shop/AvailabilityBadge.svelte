<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';
  import { num } from '$lib/format';
  import { DEAL_LABEL, type Availability } from './shop-view';

  let { availability }: { availability: Availability } = $props();

  const alarming = $derived(availability.kind === 'hidden' || availability.kind === 'not-sold');
</script>

<div class="flex flex-wrap items-center gap-1.5">
  {#if availability.tip}
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <span {...props} class="inline-flex">
              <Badge variant={alarming ? 'destructive' : 'outline'}>{availability.label}</Badge>
            </span>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content class="max-w-xs">{availability.tip}</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  {:else}
    <span
      class={availability.kind === 'in-today' || availability.kind === 'always'
        ? 'text-sm text-dark-0'
        : 'text-sm text-dark-2'}>{availability.label}</span
    >
  {/if}
  {#if availability.deal !== null}
    <Badge class="border-transparent bg-amber-500/15 text-amber-300">
      Deal {DEAL_LABEL} → {num(availability.deal)}
    </Badge>
  {/if}
</div>
