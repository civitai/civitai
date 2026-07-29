<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { SvelteSet } from 'svelte/reactivity';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogCancel,
    AlertDialogAction,
  } from '@civitai/ui/components/ui/alert-dialog/index.js';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import {
    MIN_ACCESS_PRICE,
    MIN_GENERATION_PRICE,
    MAX_GENERATION_TRIAL_LIMIT,
    DEFAULT_GENERATION_TRIAL_LIMIT,
  } from '$lib/monetization/early-access';

  // Bulk permanent-paid-access bar, scoped to one usage type (the toggle drives a `usage` list filter in
  // the parent so the price fields are unambiguous). Owns its own pricing state + confirm dialog; the
  // caller owns the shared `selected` set, the usage filter, and the version list / checkboxes.
  let {
    permanentCap,
    permanentUsed,
    matchingVersionIds,
    usage,
    selected,
    onSetUsage,
    onSelectAll,
    cancelHref,
  }: {
    permanentCap: number | null;
    permanentUsed: number;
    matchingVersionIds: number[];
    usage: string;
    selected: SvelteSet<number>;
    onSetUsage: (usage: 'download' | 'generation') => void;
    onSelectAll: (ids: number[]) => void;
    cancelHref: string;
  } = $props();

  const bulkGenOnly = $derived(usage === 'generation');
  // Permanent slots still available (null cap = unlimited) — "max minus current".
  const remainingPermanentSlots = $derived(
    permanentCap === null ? Infinity : Math.max(0, permanentCap - permanentUsed)
  );

  let bulkAccessPrice = $state<number | undefined>(MIN_ACCESS_PRICE);
  let bulkGenerationPrice = $state<number | undefined>();
  let bulkFreePreviews = $state<number | undefined>(DEFAULT_GENERATION_TRIAL_LIMIT);
  let showConfirm = $state(false);
  let form = $state<HTMLFormElement>();

  const paidAccessEnhance =
    () =>
    async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await event.update({ reset: false });
      if (event.result.type === 'success') {
        const n = Number(event.result.data?.updated ?? 0);
        const failed = Number(event.result.data?.failed ?? 0);
        toast.success(
          `Permanent paid access set on ${n} version${n === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`
        );
        selected.clear();
        // Refresh so permanent-slot counts (and the row chips) reflect the change.
        await invalidateAll();
      } else if (event.result.type === 'failure') {
        toast.error(String(event.result.data?.error ?? 'Failed'));
      }
    };
</script>

<div
  class="sticky top-2 z-10 mb-4 flex flex-col gap-3 rounded-lg border border-[#9775fa]/40 bg-dark-6 p-3 shadow-lg"
>
  <div class="flex w-fit overflow-hidden rounded-md border border-dark-4 text-xs">
    <button
      type="button"
      onclick={() => onSetUsage('download')}
      class="px-2.5 py-1 font-medium {!bulkGenOnly ? 'bg-[#9775fa]/20 text-white' : 'text-dark-2 hover:text-white'}"
    >
      Downloadable
    </button>
    <button
      type="button"
      onclick={() => onSetUsage('generation')}
      class="border-l border-dark-4 px-2.5 py-1 font-medium {bulkGenOnly ? 'bg-[#9775fa]/20 text-white' : 'text-dark-2 hover:text-white'}"
    >
      Generation-only
    </button>
  </div>
  <div class="flex flex-wrap items-center gap-3">
    <div class="flex flex-col">
      <span class="text-sm font-medium text-white">
        {selected.size > 0
          ? `${selected.size} selected`
          : `Select ${bulkGenOnly ? 'generation-only' : 'downloadable'} versions`}
      </span>
      <span class="text-xs text-dark-3">
        {#if permanentCap === null}
          {permanentUsed} permanent · unlimited on your tier
        {:else}
          {selected.size} of {remainingPermanentSlots} available slot{remainingPermanentSlots === 1 ? '' : 's'} ({permanentUsed} of {permanentCap} used)
        {/if}
      </span>
    </div>
    {#if matchingVersionIds.length > 0 && remainingPermanentSlots > 0}
      <Button
        variant="outline"
        size="sm"
        onclick={() => onSelectAll(matchingVersionIds)}
        title="Select up to your available permanent slots"
      >
        Select {Math.min(matchingVersionIds.length, remainingPermanentSlots)}
      </Button>
    {/if}
    {#if selected.size > 0}
      <Button variant="outline" size="sm" onclick={() => selected.clear()}>Clear</Button>
    {/if}
    <form
      bind:this={form}
      method="POST"
      action="?/bulkSetPaidAccess"
      use:enhance={paidAccessEnhance}
      class="contents"
    >
      <input type="hidden" name="versionIds" value={[...selected].join(',')} />
      <label class="flex items-center gap-1.5 text-xs text-dark-1">
        {bulkGenOnly ? 'Generation' : 'Access'}
        <NumberInput
          name="accessPrice"
          min={MIN_ACCESS_PRICE}
          bind:value={bulkAccessPrice}
          aria-label={bulkGenOnly ? 'Generation price' : 'Price for access'}
          class="h-7 w-24"
        />
      </label>
      {#if !bulkGenOnly}
        <label class="flex items-center gap-1.5 text-xs text-dark-1">
          Gen-only
          <NumberInput
            name="generationPrice"
            min={MIN_GENERATION_PRICE}
            max={bulkAccessPrice}
            bind:value={bulkGenerationPrice}
            aria-label="Generation-only price (optional)"
            class="h-7 w-24"
          />
        </label>
      {/if}
      <label class="flex items-center gap-1.5 text-xs text-dark-1">
        Free prev
        <NumberInput
          name="freePreviewGenerations"
          min={0}
          max={MAX_GENERATION_TRIAL_LIMIT}
          bind:value={bulkFreePreviews}
          aria-label="Free preview generations"
          class="h-7 w-16"
        />
      </label>
      <Button size="sm" disabled={selected.size === 0} onclick={() => (showConfirm = true)}>
        Apply{selected.size > 0 ? ` to ${selected.size}` : ''}
      </Button>
      <Button href={cancelHref} data-sveltekit-replacestate variant="outline" size="sm">Cancel</Button>
      <span class="text-xs text-dark-1">
        {bulkGenOnly ? '⚡ Buyers pay to generate on-site.' : '⚡ Access unlocks download + generation.'}
      </span>
    </form>
  </div>
</div>

<AlertDialog bind:open={showConfirm}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>
        Set permanent paid access on {selected.size} version{selected.size === 1 ? '' : 's'}?
      </AlertDialogTitle>
      <AlertDialogDescription>
        These versions will require purchase indefinitely (no end date).
        {bulkGenOnly
          ? `Buyers pay ${bulkAccessPrice ?? 0} ⚡ to generate on-site.`
          : `Buyers unlock download + generation for ${bulkAccessPrice ?? 0} ⚡.`}
        This uses {selected.size} of your permanent slots.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onclick={() => {
          showConfirm = false;
          form?.requestSubmit();
        }}>Apply</AlertDialogAction
      >
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
