<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Result = { scope?: string; error?: string; cases?: number; notices?: number };
  const PANEL = 'rounded-xl border border-dark-4 bg-dark-6 p-5';
  const result = $derived(form as Result | null);
</script>

<svelte:head><title>Takedown Cases</title></svelte:head>

<div class="space-y-6 p-4">
  <h1 class="text-xl font-semibold text-white">Takedown cases</h1>

  {#if data.storeError}
    <ErrorAlert message={data.storeError} />
  {/if}

  <section class="space-y-2 {PANEL}">
    {#if data.brake.paused}
      <p class="text-sm">
        <Badge variant="destructive">Sends paused</Badge>
        {data.brake.reason} ({data.brake.by === 'system' ? 'automatic' : `user ${data.brake.by}`},
        {dateTime(data.brake.at)})
      </p>
      {#if data.grants.unpause}
        <form method="POST" action="?/resume" use:enhance>
          <Button type="submit" variant="outline">Resume sends</Button>
        </form>
      {:else}
        <p class="text-sm text-dark-2">Only the Mod Lead can resume sends.</p>
      {/if}
    {:else if data.grants.act}
      <form method="POST" action="?/pause" use:enhance class="flex gap-2">
        <Input name="reason" placeholder="Why pause?" required class="max-w-sm" />
        <Button type="submit" variant="destructive">Pause all sends</Button>
      </form>
    {/if}
  </section>

  {#if result?.error}
    <p class="text-sm text-red-300">{result.error}</p>
  {:else if result?.scope === 'import'}
    <p class="text-sm text-dark-0">Imported {result.cases} cases and {result.notices} notices.</p>
  {:else if result?.scope === 'undo'}
    <p class="text-sm text-dark-0">Removed the import: {result.cases} cases.</p>
  {:else if result?.scope === 'pause'}
    <p class="text-sm text-dark-0">Sends paused.</p>
  {:else if result?.scope === 'resume'}
    <p class="text-sm text-dark-0">Sends resumed.</p>
  {/if}

  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Batch</TableHead>
        <TableHead>Cases</TableHead>
        <TableHead>Sent</TableHead>
        <TableHead>Imported</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.batches as batch (batch.batchId)}
        <TableRow>
          <TableCell>
            <a class={LINK_CLASS} href="/cases/batch/{batch.batchId}">{batch.batchId}</a>
          </TableCell>
          <TableCell>{batch.cases}</TableCell>
          <TableCell>{batch.sent} of {batch.notices}</TableCell>
          <TableCell>{dateTime(new Date(batch.importedAt))}</TableCell>
          <TableCell>
            {#if data.grants.act && batch.sent === 0}
              <form
                method="POST"
                action="?/undo"
                use:enhance={({ cancel }) => {
                  if (!confirm(`Delete every case and notice of ${batch.batchId}?`)) cancel();
                }}
              >
                <input type="hidden" name="batchId" value={batch.batchId} />
                <Button type="submit" variant="outline" size="sm">Undo import</Button>
              </form>
            {/if}
          </TableCell>
        </TableRow>
      {:else}
        <TableRow><TableCell colspan={5} class="text-dark-2">No batches.</TableCell></TableRow>
      {/each}
    </TableBody>
  </Table>

  {#if data.grants.act}
    <form method="POST" action="?/import" enctype="multipart/form-data" use:enhance class="flex gap-2">
      <Input type="file" name="file" accept="application/json" required class="max-w-sm" />
      <Button type="submit">Import batch</Button>
    </form>
  {/if}
</div>
