<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
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
  import { LINK_CLASS } from '$lib/format';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const eventOf = (params: unknown) => {
    const event = (params as { event?: unknown } | null)?.event;
    return typeof event === 'string' ? event : null;
  };
</script>

<header class="page-header">
  <h1>Mystery Boxes</h1>
</header>

<form method="POST" action="?/create" use:enhance class="mb-6 flex max-w-xl items-end gap-2">
  <div class="flex-1">
    <label class="text-sm text-dark-2" for="box-name">New box</label>
    <Input id="box-name" name="name" class="mt-1" placeholder="Birthday Mystery Box" required />
  </div>
  <Button type="submit">Create draft</Button>
</form>
{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{/if}

{#if data.boxes.length === 0}
  <p class="text-sm text-dark-2">No boxes yet.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Box</TableHead>
        <TableHead>Event</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Version</TableHead>
        <TableHead>Listings</TableHead>
        <TableHead>Held</TableHead>
        <TableHead>Opened</TableHead>
        <TableHead><span class="sr-only">Openings</span></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.boxes as box (box.id)}
        <TableRow>
          <TableCell>
            <a class={LINK_CLASS} href="/items/boxes/{box.id}">#{box.id} {box.name}</a>
          </TableCell>
          <TableCell class="text-dark-2">{eventOf(box.params) ?? '—'}</TableCell>
          <TableCell><Badge variant="outline">{box.status}</Badge></TableCell>
          <TableCell class="text-dark-2">{box.version}</TableCell>
          <TableCell class="text-dark-2">{box.listings}</TableCell>
          <TableCell class="text-dark-2">{box.held}</TableCell>
          <TableCell class="text-dark-2">{box.opened}</TableCell>
          <TableCell>
            <a class="text-sm {LINK_CLASS}" href="/items/boxes/{box.id}/openings">
              Openings
            </a>
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/if}
