<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { urlWith } from '$lib/url';
  import type { PageData } from './$types';

  type Preview = { cosmetics: number; alreadyDefined: number; missingIds: number[] };
  type Created = { created: number; alreadyDefined: number };

  let { data }: { data: PageData } = $props();

  const NO_EVENT = '__none';
  let createEvent = $state('');
  let ids = $state('');
  let result = $state<{ preview?: Preview; created?: Created } | null>(null);

  const creating = new FormState({
    onSuccess: (answer) => (result = answer as typeof result),
    onSubmit: () => (result = null),
    reload: true,
    reset: false,
  });
  // A result describes the selection it was asked for, not the one now in the form.
  const select = (event: string) => ((createEvent = event), (result = null));
</script>

<header class="page-header">
  <h1>Item Definitions</h1>
</header>

<p class="mb-4 max-w-3xl text-sm text-dark-2">
  A box holds item definitions, not cosmetics. Create one per cosmetic here before adding it to a box.
  A cosmetic that already has one is skipped, so it is safe to run twice.
</p>

<section class="mb-6 max-w-3xl rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-base font-semibold text-white">Create from cosmetics</h2>
  <form method="POST" action="?/preview" use:enhance={creating.enhance} class="space-y-3">
    <div>
      <label class="text-sm text-dark-2" for="def-event">Every cosmetic of an event</label>
      <input type="hidden" name="event" value={createEvent} />
      <Select.Root
        type="single"
        bind:value={() => createEvent || NO_EVENT, (v) => select(v === NO_EVENT ? '' : v)}
      >
        <Select.Trigger id="def-event" class="mt-1 w-64">{createEvent || 'No event'}</Select.Trigger>
        <Select.Content>
          <Select.Item value={NO_EVENT}>No event</Select.Item>
          {#each data.events as event (event)}
            <Select.Item value={event}>{event}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div>
      <label class="text-sm text-dark-2" for="def-ids">Or these cosmetic ids</label>
      <Textarea
        id="def-ids"
        name="cosmeticIds"
        rows={3}
        class="mt-1"
        disabled={!!createEvent}
        placeholder="101, 102, 103"
        bind:value={() => ids, (v) => ((ids = v ?? ''), (result = null))}
      />
    </div>
    <div class="flex gap-2">
      <Button type="submit" variant="outline" disabled={creating.submitting}>Preview</Button>
      <Button type="submit" formaction="?/create" disabled={creating.submitting}>
        Create definitions
      </Button>
    </div>
  </form>

  {#if creating.error}
    <ErrorAlert class="mt-3" message={creating.error} />
  {/if}
  {#if result?.preview}
    <p class="mt-3 text-sm text-dark-0">
      {result.preview.cosmetics} cosmetics match; {result.preview.alreadyDefined} already have a definition.
      {#if result.preview.missingIds.length}
        <span class="text-red-300">No cosmetic with id {result.preview.missingIds.join(', ')}.</span>
      {/if}
    </p>
  {/if}
  {#if result?.created}
    <p class="mt-3 text-sm text-dark-0">
      Created {result.created.created}; {result.created.alreadyDefined} already had one.
    </p>
  {/if}
</section>

<div class="mb-3 flex items-center gap-2">
  <span class="text-sm text-dark-2">Show</span>
  <Select.Root
    type="single"
    value={data.event || NO_EVENT}
    onValueChange={(v) => goto(urlWith(page.url, { event: v === NO_EVENT ? null : v, page: null }))}
  >
    <Select.Trigger class="w-64">{data.event || 'All events'}</Select.Trigger>
    <Select.Content>
      <Select.Item value={NO_EVENT}>All events</Select.Item>
      {#each data.events as event (event)}
        <Select.Item value={event}>{event}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>

{#if data.rows.length === 0}
  <p class="text-sm text-dark-2">No cosmetic definitions{data.event ? ` for ${data.event}` : ''}.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Definition</TableHead>
        <TableHead>Cosmetic</TableHead>
        <TableHead>Type</TableHead>
        <TableHead>Event</TableHead>
        <TableHead>Team</TableHead>
        <TableHead>Status</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.rows as row (row.id)}
        <TableRow>
          <TableCell>
            <div class="flex items-center gap-2">
              {#if row.url}
                <EdgeMedia src={row.url} width={64} alt="" class="size-8 rounded object-contain" />
              {/if}
              <span class="text-dark-0">#{row.id} {row.name}</span>
            </div>
          </TableCell>
          <TableCell class="text-dark-2">#{row.cosmeticId}</TableCell>
          <TableCell class="text-dark-2">{row.cosmeticType}</TableCell>
          <TableCell class="text-dark-2">{row.event ?? '—'}</TableCell>
          <TableCell class="text-dark-2">{row.team ?? 'every team'}</TableCell>
          <TableCell><Badge variant="outline">{row.status}</Badge></TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
  <div class="mt-3 flex gap-2">
    {#if data.page > 1}
      <Button variant="outline" size="sm" href={urlWith(page.url, { page: String(data.page - 1) })}>
        Newer
      </Button>
    {/if}
    {#if data.hasMore}
      <Button variant="outline" size="sm" href={urlWith(page.url, { page: String(data.page + 1) })}>
        Older
      </Button>
    {/if}
  </div>
{/if}
