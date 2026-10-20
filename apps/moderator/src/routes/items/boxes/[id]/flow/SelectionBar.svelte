<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import type { FormState } from '$lib/form-state.svelte';
  import { plural } from '$lib/format';
  import type { DraftTier } from '$lib/mystery-box';
  import { FALLBACK_TIER_COLOR } from './teams';

  let {
    count,
    inBox,
    pendingCosmeticIds,
    tiers,
    canDefine,
    defining,
    dockHeight,
    onplace,
    onremove,
    onclear,
  }: {
    count: number;
    /** Selected designs already in the box: the bar moves them rather than adding. */
    inBox: number;
    /** Cosmetics of the selection that still need an item definition. */
    pendingCosmeticIds: number[];
    tiers: DraftTier[];
    canDefine: boolean;
    defining: FormState;
    dockHeight: number;
    onplace: (tierKey: string) => void;
    onremove: () => void;
    onclear: () => void;
  } = $props();
</script>

<div class="fixed inset-x-0 z-40 border-t border-blue-5 bg-dark-8/95 px-4 py-2 backdrop-blur md:left-[var(--sidebar-width)]" style:bottom="{dockHeight}px">
  <div class="mx-auto flex max-w-[1280px] flex-wrap items-center gap-2">
    <b class="text-white">{count} selected</b>
    {#if pendingCosmeticIds.length}
      {#if canDefine}
        <form method="POST" action="?/define" use:enhance={defining.enhance} class="inline-flex items-center gap-2">
          <input type="hidden" name="cosmeticIds" value={JSON.stringify(pendingCosmeticIds)} />
          <Button type="submit" size="sm" variant="outline" disabled={defining.submitting || pendingCosmeticIds.length > 200}>
            Create {plural(pendingCosmeticIds.length, 'definition')}
          </Button>
        </form>
        {#if pendingCosmeticIds.length > 200}<span class="text-xs text-amber-300">At most 200 at a time.</span>{/if}
      {:else}
        <span class="text-xs text-amber-300">{plural(pendingCosmeticIds.length, 'cosmetic')} need a definition; ask someone with Item Definitions access.</span>
      {/if}
    {/if}
    <span class="text-xs text-dark-2">{inBox ? 'Move to' : 'Add to'}</span>
    {#each tiers as tier (tier.key)}
      <Button size="sm" variant="outline" style="border-left: 4px solid {tier.color ?? FALLBACK_TIER_COLOR}" onclick={() => onplace(tier.key)}>
        {tier.name || tier.key}
      </Button>
    {:else}
      <span class="text-xs text-dark-2">Add a tier first (Your box tab).</span>
    {/each}
    {#if inBox}<Button size="sm" variant="destructive" onclick={onremove}>Remove from box</Button>{/if}
    <Button size="sm" variant="ghost" class="ml-auto" onclick={onclear}>Clear</Button>
  </div>
  {#if defining.error}<ErrorAlert class="mx-auto mt-2 max-w-[1280px]" message={defining.error} />{/if}
</div>
