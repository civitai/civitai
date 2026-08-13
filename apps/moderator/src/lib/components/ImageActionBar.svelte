<script lang="ts">
  import type { SvelteSet } from 'svelte/reactivity';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { VIOLATION_TYPES } from '$lib/violations';
  import { TOS_REASONS, type CannedReason } from '$lib/moderation-reasons';

  let {
    selected,
    selectable,
    onSubmit,
    submitting,
    ownerCount = 1,
    notify = true,
    flags = true,
    blockedIds,
  }: {
    selected: SvelteSet<string | number>;
    /** Every id currently on screen, for the select-all helpers. */
    selectable: (string | number)[];
    onSubmit: SubmitFunction;
    submitting: boolean;
    /** How many accounts the selection spans — a removal here can touch accounts not looked up. */
    ownerCount?: number;
    notify?: boolean;
    flags?: boolean;
    /** Which of `selectable` are currently blocked, so Restore can warn about the rest. */
    blockedIds?: Set<string | number>;
  } = $props();

  const ids = $derived([...selected].join(','));
  const count = $derived(selected.size);
  const unblockedSelected = $derived(
    blockedIds ? [...selected].filter((id) => !blockedIds.has(id)).length : 0
  );
  // A client-side filter can hide an image that is still selected, and the removal posts ids, not what
  // is on screen. Saying so is the difference between removing 12 images and removing 40.
  const hiddenSelected = $derived.by(() => {
    const visible = new Set(selectable);
    return [...selected].filter((id) => !visible.has(id)).length;
  });

  let tosReason = $state<string | null>(null);
  let reason = $state('');
  let pendingFlag = $state<CannedReason['flag']>(undefined);
  let strikeOwners = $state(false);
  // A strike's description is what the account is shown, so it cannot be the empty string. Blocking the
  // submit rather than disabling the checkbox: a disabled checkbox does not post, so emptying the reason
  // under a ticked box would drop the strike silently and still remove the images.
  const strikeNeedsReason = $derived(strikeOwners && reason.trim() === '');

  const applyTosReason = (r: CannedReason) => {
    tosReason = r.label;
    reason = r.message;
    pendingFlag = r.flag;
    violationType = r.violation ?? 'none';
  };

  let violationType = $state('none');
  let confirming = $state<'remove' | 'restore' | null>(null);
  let notifying = $state(false);
  let flagging = $state(false);

  // The selection empties on a successful write and on a new batch. An open panel outliving either
  // leaves an armed destructive submit that would post an empty `imageIds`.
  //
  // `violationType` is reset with them: it is the value the endpoint classifies the removal by and
  // ships to ClickHouse, so carrying it across batches files the next account's removal under the
  // previous one's reason.
  $effect(() => {
    if (count === 0) {
      confirming = null;
      notifying = false;
      flagging = false;
      violationType = 'none';
      tosReason = null;
      reason = '';
      pendingFlag = undefined;
      strikeOwners = false;
    }
  });

  // `n = 0`, not `n?: number` — an optional-parameter `?` survives Svelte 5's TS stripping and reaches
  // rollup as invalid JS. It breaks `build` ONLY: typecheck and dev both pass.
  const selectAll = (n = 0) => {
    for (const id of n ? selectable.slice(0, n) : selectable) selected.add(id);
  };
</script>

<section
  class={cn(
    'mb-4 rounded-xl border p-5',
    count > 0 ? 'border-blue-500/40 bg-blue-500/5' : 'border-dark-4 bg-dark-6'
  )}
>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-sm text-dark-2">
      {#if count === 0}
        Select images to act on them.
      {:else}
        <span class="font-semibold text-white">{num(count)}</span> selected
        {#if ownerCount > 1}
          <span class="text-amber-300">· spanning {ownerCount} accounts</span>
        {/if}
        {#if hiddenSelected > 0}
          <span class="text-amber-300">· {num(hiddenSelected)} not shown by the current filter</span>
        {/if}
      {/if}
    </p>

    <div class="flex flex-wrap gap-2">
      {#if selectable.length > 0}
        <Button size="sm" variant="outline" onclick={() => selectAll()}>
          Select all {num(selectable.length)}
        </Button>
        {#if selectable.length > 100}
          <Button size="sm" variant="outline" onclick={() => selectAll(100)}>Select 100</Button>
        {/if}
        {#if selectable.length > 50}
          <Button size="sm" variant="outline" onclick={() => selectAll(50)}>Select 50</Button>
        {/if}
      {/if}
      {#if count > 0}
        <Button size="sm" variant="outline" onclick={() => selected.clear()}>Unselect all</Button>
      {/if}
    </div>
  </div>

  {#if count > 0 && !confirming && !notifying && !flagging}
    <div class="mt-3 flex flex-wrap gap-2">
      <Button size="sm" variant="destructive" onclick={() => (confirming = 'remove')}>
        Remove selected
      </Button>
      <!-- Confirmed like Remove. It sits next to a destructive button and is itself destructive in a
           way that reads as safe: restore clears needsReview, poi and blockedFor, republishes at
           `ingestion = 'Scanned'` and disables the review tags, with no record of the prior values. -->
      <Button size="sm" onclick={() => (confirming = 'restore')}>Restore selected</Button>
      {#if notify}
        <Button size="sm" onclick={() => (notifying = true)}>Notify owners</Button>
      {/if}
      {#if flags}
        <Button size="sm" variant="outline" onclick={() => (flagging = !flagging)}>Flags</Button>
      {/if}
    </div>
  {/if}

  {#if confirming === 'remove'}
    <form method="POST" action="?/remove" use:enhance={onSubmit} class="mt-3">
      <input type="hidden" name="imageIds" value={ids} />
      <div class="rounded-md border border-red-500/40 bg-red-500/10 p-3">
        <p class="mb-2 text-sm text-white">
          Remove <strong>{num(count)}</strong> images
          {#if ownerCount > 1}across <strong>{ownerCount}</strong> accounts{/if}? Their owners are not
          notified unless you also send a message.
        </p>
        <!-- Retool's TosReasons radio. Picking one fills the reason with the wording the user is
             sent, and pre-selects the violation type and the flag it implies — moderators were
             otherwise writing eleven standard messages by hand. -->
        <div class="mb-2 flex flex-wrap gap-1.5">
          {#each TOS_REASONS as r (r.label)}
            <button
              type="button"
              onclick={() => applyTosReason(r)}
              aria-pressed={tosReason === r.label}
              class={cn(
                'rounded-md border px-2 py-1 text-xs',
                tosReason === r.label
                  ? 'border-primary bg-primary/15 text-white'
                  : 'border-dark-4 text-dark-2 hover:bg-dark-5 hover:text-dark-0'
              )}
            >
              {r.label}
            </button>
          {/each}
        </div>
        {#if pendingFlag}
          <p class="mb-2 text-xs text-amber-200">
            This reason also sets <strong>{pendingFlag}</strong> on the selected images.
          </p>
          <input type="hidden" name="alsoFlag" value={pendingFlag} />
        {/if}

        <div class="mb-2 flex flex-wrap gap-2">
          <!-- The endpoint classifies removals by this enum and ships it to ClickHouse; free text
               alone left every removal from this page unclassified. -->
          <Select.Root type="single" bind:value={violationType}>
            <Select.Trigger class="w-52">
              {violationType === 'none' ? 'Violation type (optional)' : violationType}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="none">No violation type</Select.Item>
              {#each VIOLATION_TYPES as v (v)}
                <Select.Item value={v}>{v}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if violationType !== 'none'}
            <input type="hidden" name="violationType" value={violationType} />
          {/if}
          <Input
            name="reason"
            bind:value={reason}
            placeholder="Reason (optional, recorded with the removal)"
            class="min-w-48 flex-1"
          />
        </div>
        <!-- Retool's strikeCheckbox. The removal and the strike for it were one gesture there; without
             it a moderator leaves for User Lookup once per owner. -->
        <label class="mb-2 flex items-start gap-2 text-sm text-white">
          <input
            type="checkbox"
            name="strikeOwners"
            value="1"
            bind:checked={strikeOwners}
            class="mt-0.5"
          />
          <span>
            Strike {ownerCount > 1 ? `all ${ownerCount} owners` : "the owner's account"} — the reason
            above is sent as the strike's description.
          </span>
        </label>
        {#if strikeNeedsReason}
          <p class="mb-2 text-xs text-amber-200">
            A strike needs a reason: pick one above, or write the message the user should be sent.
          </p>
        {/if}

        <div class="flex gap-2">
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            disabled={submitting || strikeNeedsReason}
          >
            {submitting ? 'Removing…' : `Remove ${num(count)}`}
          </Button>
          <Button type="button" size="sm" variant="outline" onclick={() => (confirming = null)}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  {/if}

  {#if confirming === 'restore'}
    <form method="POST" action="?/restore" use:enhance={onSubmit} class="mt-3">
      <input type="hidden" name="imageIds" value={ids} />
      <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
        <p class="mb-2 text-sm text-white">
          Restore <strong>{num(count)}</strong> images? This clears <code>needsReview</code>,
          <code>poi</code> and <code>blockedFor</code>, republishes them, and disables their review
          tags. The previous values are not recorded anywhere.
        </p>
        {#if unblockedSelected > 0}
          <!-- Restore is meant for already-blocked images; most sources return every image an account
               owns, so a Select-all here silently clears the review queue for the rest. -->
          <p class="mb-2 text-sm text-amber-200">
            {num(unblockedSelected)} of these are not currently blocked — restoring those drops them out
            of the POI and minor review queues.
          </p>
        {/if}
        <div class="flex gap-2">
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? 'Restoring…' : `Restore ${num(count)}`}
          </Button>
          <Button type="button" size="sm" variant="outline" onclick={() => (confirming = null)}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  {/if}

  {#if flagging}
    <form method="POST" action="?/setFlag" use:enhance={onSubmit} class="mt-3">
      <input type="hidden" name="imageIds" value={ids} />
      <p class="mb-2 text-xs text-dark-2">
        POI marks a real person; minor marks a depicted minor. Setting either restricts the image.
      </p>
      <!-- One field carries both, because a submit button contributes a single name/value pair. -->
      <div class="flex flex-wrap gap-2">
        {#each [['poi:true', 'Set POI'], ['poi:false', 'Clear POI'], ['minor:true', 'Set minor'], ['minor:false', 'Clear minor']] as [value, label] (value)}
          <Button
            type="submit"
            name="flagValue"
            {value}
            size="sm"
            variant="outline"
            disabled={submitting}
          >
            {label}
          </Button>
        {/each}
        <Button type="button" size="sm" variant="outline" onclick={() => (flagging = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}

  {#if notifying}
    <form method="POST" action="?/notifyOwners" use:enhance={onSubmit} class="mt-3">
      <input type="hidden" name="imageIds" value={ids} />
      <p class="mb-2 text-xs text-dark-2">One notification per affected account, not per image.</p>
      <Textarea name="message" rows={2} placeholder="What should these users be told?" required />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" disabled={submitting}>Send</Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (notifying = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}
</section>
