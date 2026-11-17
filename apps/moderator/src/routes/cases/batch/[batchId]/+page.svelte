<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
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
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Result = { scope?: string; error?: string; started?: boolean; updated?: string[]; refused?: string[] };
  const result = $derived(form as Result | null);
  const allDone = $derived(data.counts.length > 0 && data.counts.every((c) => c.done));

  // While a send runs, re-read the rows every 3 s so the counts move.
  $effect(() => {
    if (!data.running) return;
    const t = setInterval(() => invalidateAll(), 3000);
    return () => clearInterval(t);
  });

  const stale = (row: { status: string; attemptedAt: Date | null }) =>
    row.status === 'sending' && !!row.attemptedAt && new Date(row.attemptedAt).getTime() < data.staleBefore;
</script>

<svelte:head><title>Batch {data.batchId}</title></svelte:head>

<div class="space-y-6 p-4">
  <h1 class="text-xl font-semibold">Batch {data.batchId}</h1>

  {#if data.storeError}
    <p class="rounded-md border border-destructive p-3 text-sm">{data.storeError}</p>
  {/if}

  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Notice</TableHead>
        <TableHead>Expected</TableHead>
        <TableHead>Sent</TableHead>
        <TableHead>Failed</TableHead>
        <TableHead>Pending</TableHead>
        <TableHead>Sending</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.counts as c (c.noticeId)}
        <TableRow>
          <TableCell>{c.noticeId}</TableCell>
          <TableCell>{c.expected ?? 'not stated'}</TableCell>
          <TableCell>{c.sent}{c.expected ? ` of ${c.expected}` : ''}</TableCell>
          <TableCell>{c.failed}</TableCell>
          <TableCell>{c.pending}</TableCell>
          <TableCell>{c.sending}</TableCell>
          <TableCell>
            {#if c.done}<Badge>done</Badge>{:else}<Badge variant="outline">not done</Badge>{/if}
          </TableCell>
        </TableRow>
      {:else}
        <TableRow><TableCell colspan={7} class="text-dark-2">Nothing imported for this batch.</TableCell></TableRow>
      {/each}
    </TableBody>
  </Table>
  <p class="text-sm">{allDone ? 'Every notice type is sent as expected.' : 'Not done.'}</p>

  {#if result?.error}
    <p class="text-sm text-destructive">{result.error}</p>
  {:else if result?.scope === 'send'}
    <p class="text-sm">{result.started ? 'Sending started.' : 'A send of this batch is already running.'}</p>
  {:else if result?.scope === 'importSent'}
    <p class="text-sm">Marked {result.updated?.length ?? 0} sent; refused {result.refused?.length ?? 0} already sent or not in this batch.</p>
  {/if}

  {#if data.canAct}
    <div class="flex flex-wrap items-center gap-3">
      {#if data.brake.paused}
        <Badge variant="destructive">Sends paused: {data.brake.reason}</Badge>
      {:else}
        <form method="POST" action="?/send" use:enhance>
          <Button type="submit" disabled={data.running}>{data.running ? 'Sending…' : 'Send unsent notices'}</Button>
        </form>
      {/if}
      <a class="text-sm underline" href="/cases/batch/{data.batchId}/export">Export unsent rows</a>
      <form method="POST" action="?/importSent" enctype="multipart/form-data" use:enhance class="flex gap-2">
        <Input type="file" name="file" accept=".jsonl,text/plain" required class="max-w-xs" />
        <Button type="submit" variant="outline">Import sent.jsonl</Button>
      </form>
    </div>
  {/if}

  {#if data.preview}
    <h2 class="font-semibold">Preview ({data.preview.length} messages)</h2>
    <ol class="space-y-3">
      {#each data.preview as row (row.id)}
        <li class="rounded-md border p-3 text-sm">
          <div class="flex flex-wrap gap-2">
            <Badge variant="outline">{row.noticeId}</Badge>
            <span>{row.caseRef}</span>
            <span>to {row.recipientRole}: {row.to}</span>
            <Badge variant={row.status === 'sent' ? 'default' : 'outline'}>
              {stale(row) ? 'unknown (check before resending)' : row.status}
            </Badge>
            {#if row.error}<span class="text-destructive">{row.error}</span>{/if}
          </div>
          <p class="mt-2 font-medium">{row.subject}</p>
          <pre class="mt-1 whitespace-pre-wrap text-dark-2">{row.body}</pre>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="text-sm text-dark-2">The message preview needs the cases.pii grant.</p>
  {/if}
</div>
