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
  import { VIOLATION_TYPES } from './sources';

  let {
    selected,
    onSubmit,
    submitting,
    ownerCount,
  }: {
    selected: SvelteSet<string | number>;
    onSubmit: SubmitFunction;
    submitting: boolean;
    ownerCount: number;
  } = $props();

  const ids = $derived([...selected].join(','));
  const count = $derived(selected.size);

  let violationType = $state('none');
  let confirming = $state<'remove' | null>(null);
  let notifying = $state(false);
  let flagging = $state(false);

  // The selection empties on a successful write and on a new batch. An open panel outliving either
  // leaves an armed destructive submit that would post an empty `imageIds`.
  $effect(() => {
    if (count === 0) {
      confirming = null;
      notifying = false;
      flagging = false;
    }
  });
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
          <span class="text-amber-300">
            · spanning {ownerCount} accounts
          </span>
        {/if}
      {/if}
    </p>

    {#if count > 0 && !confirming && !notifying && !flagging}
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="destructive" onclick={() => (confirming = 'remove')}>
          Remove selected
        </Button>
        <form method="POST" action="?/restore" use:enhance={onSubmit}>
          <input type="hidden" name="imageIds" value={ids} />
          <Button type="submit" size="sm" disabled={submitting}>Restore selected</Button>
        </form>
        <Button size="sm" onclick={() => (notifying = true)}>Notify owners</Button>
        <Button size="sm" variant="outline" onclick={() => (flagging = !flagging)}>Flags</Button>
      </div>
    {/if}
  </div>

  {#if confirming === 'remove'}
    <form method="POST" action="?/remove" use:enhance={onSubmit} class="mt-3">
      <input type="hidden" name="imageIds" value={ids} />
      <div class="rounded-md border border-red-500/40 bg-red-500/10 p-3">
        <p class="mb-2 text-sm text-white">
          Remove <strong>{num(count)}</strong> images
          {#if ownerCount > 1}across <strong>{ownerCount}</strong> accounts{/if}? Their owners are not
          notified unless you also send a message.
        </p>
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
            placeholder="Reason (optional, recorded with the removal)"
            class="min-w-48 flex-1"
          />
        </div>
        <div class="flex gap-2">
          <Button type="submit" size="sm" variant="destructive" disabled={submitting}>
            {submitting ? 'Removing…' : `Remove ${num(count)}`}
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
      <p class="mb-2 text-xs text-dark-2">
        One notification per affected account, not per image.
      </p>
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
