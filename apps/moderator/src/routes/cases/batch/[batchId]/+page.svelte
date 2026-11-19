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
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Result = {
    scope?: string;
    error?: string;
    started?: boolean;
    updated?: number[];
    refused?: number[];
    rowId?: number;
    outcome?: string;
  };
  const result = $derived(form as Result | null);
  const PANEL = 'rounded-xl border border-dark-4 bg-dark-6 p-5';

  // While a send runs, poll the counts only: reloading the page would re-read (and re-record) the
  // recipient preview every few seconds.
  let live = $state<{ running: boolean; counts: PageData['counts'] } | null>(null);
  const running = $derived(live?.running ?? data.running);
  const counts = $derived(live?.counts ?? data.counts);
  const allDone = $derived(counts.length > 0 && counts.every((c) => c.done));
  let submitting = $state(false);

  $effect(() => {
    if (!data.running && !submitting) return;
    let stopped = false;
    const t = setInterval(async () => {
      const res = await fetch(`/cases/batch/${data.batchId}/counts`).catch(() => null);
      if (stopped || !res?.ok) return;
      live = await res.json();
      // The send finished: reload once so the preview shows the final statuses.
      if (!live?.running) {
        stopped = true;
        clearInterval(t);
        live = null;
        submitting = false;
        await invalidateAll();
      }
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  });

  // `sending` with an error, or for too long: it may have been delivered, so it is checked by hand.
  const unknown = (row: { status: string; error: string | null; attemptedAt: Date | null }) =>
    row.status === 'sending' &&
    (!!row.error ||
      (!!row.attemptedAt && new Date(row.attemptedAt).getTime() < data.staleBefore));
</script>

<svelte:head><title>Batch {data.batchId}</title></svelte:head>

<div class="space-y-6 p-4">
  <h1 class="text-xl font-semibold text-white">Batch {data.batchId}</h1>

  {#if data.storeError}
    <ErrorAlert message={data.storeError} />
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Notice</TableHead>
          <TableHead>Expected</TableHead>
          <TableHead>Sent</TableHead>
          <TableHead>Failed</TableHead>
          <TableHead>Pending</TableHead>
          <TableHead>Sending</TableHead>
          <TableHead>Dropped</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each counts as c (c.noticeId)}
          <TableRow>
            <TableCell>{c.noticeId}</TableCell>
            <TableCell>{c.expected ?? 'not stated'}</TableCell>
            <TableCell>{c.sent}{c.expected ? ` of ${c.expected}` : ''}</TableCell>
            <TableCell>{c.failed}</TableCell>
            <TableCell>{c.pending}</TableCell>
            <TableCell>{c.sending}</TableCell>
            <TableCell>{c.dropped}</TableCell>
            <TableCell>
              {#if c.done}<Badge>done</Badge>{:else}<Badge variant="outline">not done</Badge>{/if}
            </TableCell>
          </TableRow>
        {:else}
          <TableRow>
            <TableCell colspan={8} class="text-dark-2">Nothing imported for this batch.</TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
    <p class="text-sm text-dark-0">
      {allDone ? 'Every notice type is sent as expected.' : 'Not done.'}
    </p>
  {/if}

  {#if result?.error}
    <p class="text-sm text-red-300">{result.error}</p>
  {:else if result?.scope === 'send' && running}
    <p class="text-sm text-dark-0">
      {result.started ? 'Sending started.' : 'A send of this batch is already running.'}
    </p>
  {:else if result?.scope === 'withdraw'}
    <p class="text-sm text-dark-0">Row {result.rowId} withdrawn; it will not be sent.</p>
  {:else if result?.scope === 'retire'}
    <p class="text-sm text-dark-0">Row {result.rowId} retired.</p>
  {:else if result?.scope === 'resolve'}
    <p class="text-sm text-dark-0">Row {result.rowId} marked {result.outcome}.</p>
  {:else if result?.scope === 'importSent'}
    <p class="text-sm text-dark-0">
      Marked {result.updated?.length ?? 0} sent; refused {result.refused?.length ?? 0} already sent
      or not in this batch.
    </p>
  {/if}

  {#if data.canAct}
    <div class="flex flex-wrap items-center gap-3 {PANEL}">
      {#if data.brake.paused}
        <Badge variant="destructive">Sends paused: {data.brake.reason}</Badge>
      {:else if !data.storeError}
        <form
          method="POST"
          action="?/send"
          use:enhance={({ cancel }) => {
            if (!confirm(`Send every unsent notice of ${data.batchId} now?`)) return cancel();
            submitting = true;
            return async ({ update, result: r }) => {
              if (r.type !== 'success') submitting = false;
              await update();
            };
          }}
        >
          <Button type="submit" disabled={running || submitting}>
            {running || submitting ? 'Sending…' : 'Send unsent notices'}
          </Button>
        </form>
      {/if}
      <!-- A native post: the response is a file download, not an action result. -->
      <form
        method="POST"
        action="/cases/batch/{data.batchId}/export"
        data-sveltekit-reload
        onsubmit={(e) => {
          const ask =
            'Exporting holds in-app sends of this batch until its sent.jsonl is imported, ' +
            'and the batch can no longer be undone. Export?';
          if (!confirm(ask)) e.preventDefault();
        }}
      >
        <Button type="submit" variant="outline">Export unsent rows for the fallback</Button>
      </form>
      <form
        method="POST"
        action="?/importSent"
        enctype="multipart/form-data"
        use:enhance
        class="flex gap-2"
      >
        <Input type="file" name="file" accept=".jsonl,text/plain" required class="max-w-xs" />
        <Button type="submit" variant="outline">Import sent.jsonl</Button>
      </form>
    </div>
  {/if}

  {#if data.preview}
    <h2 class="font-semibold text-white">Preview ({data.preview.length} messages)</h2>
    <ol class="space-y-3">
      {#each data.preview as row (row.id)}
        <li class="text-sm {PANEL}">
          <div class="flex flex-wrap gap-2">
            <Badge variant="outline">{row.noticeId}</Badge>
            <span>{row.caseRef}</span>
            <span>to {row.recipientRole}: {row.to}</span>
            <Badge variant={row.status === 'sent' ? 'default' : 'outline'}>
              {unknown(row) ? 'unknown (check before resending)' : row.status}
            </Badge>
            {#if row.error}<span class="text-red-300">{row.error}</span>{/if}
            {#if row.messageId}<span class="text-dark-2">message {row.messageId}</span>{/if}
          </div>
          {#if data.canAct && row.status === 'pending'}
            <form method="POST" action="?/withdraw" use:enhance class="mt-2 flex flex-wrap gap-2">
              <input type="hidden" name="rowId" value={row.id} />
              <Input name="reason" placeholder="Why withdraw?" required class="max-w-xs" />
              <Button type="submit" size="sm" variant="outline">Withdraw (never send)</Button>
            </form>
          {/if}
          {#if data.canAct && row.status === 'failed' && row.error !== 'Retired' && row.error !== 'Withdrawn'}
            <form
              method="POST"
              action="?/retire"
              use:enhance={({ cancel }) => {
                if (!confirm('Never send this notice again?')) cancel();
              }}
              class="mt-2"
            >
              <input type="hidden" name="rowId" value={row.id} />
              <Button type="submit" size="sm" variant="outline">Retire (never send)</Button>
            </form>
          {/if}
          {#if data.canAct && unknown(row)}
            <form method="POST" action="?/resolve" use:enhance class="mt-2 flex flex-wrap gap-2">
              <input type="hidden" name="rowId" value={row.id} />
              <Button type="submit" name="outcome" value="sent" size="sm" variant="outline">
                Checked: delivered
              </Button>
              <Button type="submit" name="outcome" value="failed" size="sm" variant="outline">
                Checked: not delivered (may be sent again)
              </Button>
            </form>
          {/if}
          <p class="mt-2 font-medium text-dark-0">{row.subject}</p>
          <pre class="mt-1 whitespace-pre-wrap text-dark-2">{row.body}</pre>
        </li>
      {/each}
    </ol>
  {:else if !data.storeError && !data.canPii}
    <p class="text-sm text-dark-2">The message preview needs the cases.pii grant.</p>
  {/if}
</div>
