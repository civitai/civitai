<script lang="ts" module>
  export type Listing = {
    id: number;
    title: string;
    description: string | null;
    unitAmount: number;
    availableFrom: Date | null;
    availableTo: Date | null;
    availableQuantity: number | null;
    status: string;
  };
</script>

<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';

  let { listing, defaultTitle = '' }: { listing: Listing | null; defaultTitle?: string } = $props();

  const STATUSES = ['Draft', 'Published', 'Archived'] as const;
  /** `datetime-local` wants `YYYY-MM-DDTHH:mm`; the times are UTC, and the server reads them as UTC. */
  const utcInput = (value: Date | null) => (value ? new Date(value).toISOString().slice(0, 16) : '');

  const form = new FormState({ onSuccess: null, reload: true, reset: untrack(() => !listing) });
  let status = $state(untrack(() => listing?.status ?? 'Draft'));
</script>

<form method="POST" action="?/listing" use:enhance={form.enhance} class="rounded-lg border border-dark-4 p-3">
  <h3 class="mb-2 text-sm font-semibold text-white">
    {listing ? `Listing #${listing.id}` : 'New listing'}
  </h3>
  {#if listing}
    <input type="hidden" name="listingId" value={listing.id} />
  {/if}
  <div class="grid gap-2 md:grid-cols-3">
    <label class="text-xs text-dark-2">
      Title
      <Input name="title" class="mt-1" value={listing?.title ?? defaultTitle} required />
    </label>
    <label class="text-xs text-dark-2">
      Price (Buzz)
      <Input name="unitAmount" type="number" min="1" step="1" class="mt-1" value={listing?.unitAmount ?? ''} required />
    </label>
    <label class="text-xs text-dark-2">
      Status
      <Select.Root type="single" name="status" bind:value={status}>
        <Select.Trigger class="mt-1 w-full">{status}</Select.Trigger>
        <Select.Content>
          {#each STATUSES as s (s)}
            <Select.Item value={s}>{s}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </label>
    <label class="text-xs text-dark-2 md:col-span-3">
      Description
      <Input name="description" class="mt-1" value={listing?.description ?? ''} />
    </label>
    <label class="text-xs text-dark-2">
      On sale from (UTC)
      <Input name="availableFrom" type="datetime-local" class="mt-1" value={utcInput(listing?.availableFrom ?? null)} />
    </label>
    <label class="text-xs text-dark-2">
      Until (UTC)
      <Input name="availableTo" type="datetime-local" class="mt-1" value={utcInput(listing?.availableTo ?? null)} />
    </label>
    <label class="text-xs text-dark-2">
      Quantity (empty = unlimited)
      <Input name="availableQuantity" type="number" min="1" step="1" class="mt-1" value={listing?.availableQuantity ?? ''} />
    </label>
  </div>
  <div class="mt-2 flex items-center gap-2">
    <Button type="submit" size="sm" disabled={form.submitting}>
      {listing ? 'Save listing' : form.error ? 'Retry' : 'Create listing'}
    </Button>
  </div>
  {#if form.error}
    <ErrorAlert class="mt-2" message={form.error} />
  {/if}
</form>
