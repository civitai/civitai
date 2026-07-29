<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SvelteSet } from 'svelte/reactivity';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
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
  import { feeToRatio, formatFeeRatio, FEE_IMAGE_OPTIONS, DEFAULT_FEE_IMAGES } from '$lib/monetization/fee';

  // Bulk licensing-fee bar (sibling of PaidAccessBulkBar). Owns the fee inputs + confirm dialog; the
  // caller owns the shared `selected` set and the version list / checkboxes.
  let {
    matchingVersionIds,
    selected,
    suggestedFee,
    cancelHref,
    onSelectAll,
  }: {
    matchingVersionIds: number[];
    selected: SvelteSet<number>;
    suggestedFee: number | undefined;
    cancelHref: string;
    onSelectAll: (ids: number[]) => void;
  } = $props();

  let bulkBuzz = $state<number | undefined>(1);
  let bulkImages = $state(String(DEFAULT_FEE_IMAGES));
  let showConfirm = $state(false);
  let form = $state<HTMLFormElement>();

  const bulkEnhance =
    () =>
    async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await event.update({ reset: false });
      if (event.result.type === 'success') {
        const n = Number(event.result.data?.updated ?? 0);
        toast.success(`Updated ${n} version${n === 1 ? '' : 's'}`);
        selected.clear();
      } else if (event.result.type === 'failure') {
        toast.error(String(event.result.data?.error ?? 'Failed'));
      }
    };
</script>

<div
  class="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-8/40 bg-dark-6 p-3 shadow-lg"
>
  <span class="text-sm font-medium text-white">
    {selected.size > 0 ? `${selected.size} selected` : 'Select versions to edit'}
  </span>
  {#if matchingVersionIds.length > 0}
    <Button
      variant="outline"
      size="sm"
      onclick={() => onSelectAll(matchingVersionIds)}
      title="Select every version matching the current filters (all pages)"
    >
      Select all {matchingVersionIds.length}
    </Button>
  {/if}
  {#if selected.size > 0}
    <Button variant="outline" size="sm" onclick={() => selected.clear()}>Clear</Button>
  {/if}
  <form bind:this={form} method="POST" action="?/bulkSetFee" use:enhance={bulkEnhance} class="contents">
    <input type="hidden" name="versionIds" value={[...selected].join(',')} />
    <NumberInput
      name="buzz"
      min={0}
      bind:value={bulkBuzz}
      placeholder="Buzz"
      aria-label="Buzz (leave empty to clear the fee)"
      title="Leave empty to clear the fee"
      class="h-7 w-20"
    />
    <span class="text-sm text-dark-1">⚡ per</span>
    <input type="hidden" name="images" value={bulkImages} />
    <Select.Root type="single" value={bulkImages} onValueChange={(v: string) => { if (v) bulkImages = v; }}>
      <Select.Trigger size="sm" class="w-16 text-white" aria-label="Generations">
        {bulkImages}
      </Select.Trigger>
      <Select.Content>
        {#each FEE_IMAGE_OPTIONS as opt (opt)}
          <Select.Item value={String(opt)} label={String(opt)} />
        {/each}
      </Select.Content>
    </Select.Root>
    <span class="text-sm text-dark-1">generations</span>
    <Button size="sm" disabled={selected.size === 0} onclick={() => (showConfirm = true)}>
      Apply{selected.size > 0 ? ` to ${selected.size}` : ''}
    </Button>
    <Button href={cancelHref} data-sveltekit-replacestate variant="outline" size="sm">Cancel</Button>
    {#if suggestedFee !== undefined}
      {@const sr = feeToRatio(suggestedFee)}
      <button
        type="button"
        class="text-xs text-dark-1 hover:text-white hover:underline"
        onclick={() => {
          bulkBuzz = sr.buzz;
          bulkImages = String(sr.images);
        }}
      >
        Use suggested ({formatFeeRatio(suggestedFee)})
      </button>
    {/if}
    <span class="text-xs text-dark-1">Empty buzz clears the fee.</span>
  </form>
</div>

<AlertDialog bind:open={showConfirm}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Apply fee to {selected.size} version{selected.size === 1 ? '' : 's'}?</AlertDialogTitle>
      <AlertDialogDescription>
        This changes what creators are charged to generate with these versions. An empty value clears the fee.
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
