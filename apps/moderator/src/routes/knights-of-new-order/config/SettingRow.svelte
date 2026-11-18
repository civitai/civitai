<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';

  let {
    id,
    label,
    description,
    custom,
    env,
    error = null,
    onreset,
    children,
  }: {
    id: string;
    label: string;
    description: string;
    /** Null for a row with no Knights default (it is always saved). */
    custom?: boolean | null;
    /** The environment variable behind the default, shown only in the badge tooltip. */
    env?: string;
    error?: string | null;
    onreset?: () => void;
    children: Snippet;
  } = $props();
</script>

<div class="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
  <div class="min-w-0">
    <div class="flex flex-wrap items-center gap-2">
      <span id="{id}-label" class="text-sm font-medium text-dark-0">{label}</span>
      {#if custom !== undefined && custom !== null}
        <Tooltip.Provider delayDuration={200}>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <span {...props} class="inline-flex">
                  <Badge variant={custom ? 'secondary' : 'outline'}>{custom ? 'Custom' : 'Default'}</Badge>
                </span>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content class="max-w-xs">
              {custom ? 'Saved on this page.' : `Default from ${env} when set, else built in.`}
            </Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
      {/if}
    </div>
    <p class="text-xs text-dark-2">{description}</p>
    {#if error}<p class="text-xs text-red-400" id="{id}-error">{error}</p>{/if}
  </div>
  <div class="flex items-center gap-1 sm:justify-end">
    {@render children()}
    <!-- A fixed slot, so controls stay in one column whether or not a row can be reset. -->
    <div class="flex w-16 justify-end">
      {#if custom && onreset}
        <Tooltip.Provider delayDuration={200}>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button {...props} type="button" variant="ghost" size="sm" onclick={onreset} data-touch-target>
                  Reset
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>Use the Knights default</Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
      {/if}
    </div>
  </div>
</div>
