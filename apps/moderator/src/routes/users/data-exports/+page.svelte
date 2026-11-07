<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
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
  import { userLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { denied } from '$lib/permissions';
  import { urlWith } from '$lib/url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let queued = $state<string | null>(null);
  const queueForm = new FormState({
    onSuccess: (d) => (queued = `Queued export #${String(d?.id ?? '')}. You will be emailed a link.`),
  });
  let released = $state<string | null>(null);
  let confirming = $state<number | null>(null);
  const releaseForm = new FormState({
    onSuccess: () => (released = 'Sent to the account owner.'),
    onSettled: () => (confirming = null),
  });

  type Row = PageData['exports'][number];
  const filesOf = (row: Row) =>
    (row.manifest as { files?: { rows: number; status: string }[] } | null)?.files ?? [];
  const rowsOf = (row: Row) => filesOf(row).reduce((n, f) => n + f.rows, 0);
  const unavailableOf = (row: Row) => filesOf(row).filter((f) => f.status !== 'complete').length;
  const releasable = (row: Row) => row.status === 'built';
</script>

<header class="page-header">
  <h1>Personal data exports</h1>
  <p>
    Access requests. Queueing builds an archive of the account's data and emails it to you; nothing
    reaches the account owner until someone with the release permission sends it from here, which
    checks the account's holds again first. The internal notes file is never sent to the owner.
  </p>
</header>

<section class="mb-4 flex flex-wrap items-end gap-4">
  <form method="POST" action="?/queue" use:enhance={queueForm.enhance} class="flex items-end gap-2">
    <label class="flex flex-col gap-1 text-xs text-dark-2">
      User id
      <Input name="userId" inputmode="numeric" required class="w-40" disabled={!data.canQueue} />
    </label>
    <label class="flex flex-col gap-1 text-xs text-dark-2">
      Date the user asked
      <Input
        name="requestedAt"
        type="date"
        required
        max={new Date().toISOString().slice(0, 10)}
        class="w-44"
        disabled={!data.canQueue}
      />
    </label>
    <Button
      type="submit"
      size="sm"
      disabled={!data.canQueue || queueForm.submitting}
      title={data.canQueue ? undefined : denied('user.personalDataExport.queue')}
    >
      Queue export
    </Button>
  </form>
  {#if queueForm.error}<p class="m-0 text-xs text-red-300">{queueForm.error}</p>{/if}
  {#if queued}<p class="m-0 text-xs text-green-300">{queued}</p>{/if}

  <nav class="ml-auto flex gap-3 text-sm">
    <a
      href={urlWith(page.url, { status: null })}
      class={data.status ? LINK_CLASS : 'text-white underline'}>All</a
    >
    {#each data.statuses as s (s)}
      <a
        href={urlWith(page.url, { status: s })}
        class={data.status === s ? 'text-white underline' : LINK_CLASS}>{s}</a
      >
    {/each}
  </nav>
</section>

{#if releaseForm.error}<p class="mb-2 text-xs text-red-300">{releaseForm.error}</p>{/if}
{#if released}<p class="mb-2 text-xs text-green-300">{released}</p>{/if}

{#if data.exports.length === 0}
  <p class="text-dark-2">No exports{data.status ? ` with status ${data.status}` : ''}.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>#</TableHead>
        <TableHead>Account</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Requested by</TableHead>
        <TableHead>Queued</TableHead>
        <TableHead>Built</TableHead>
        <TableHead>Records</TableHead>
        <TableHead>Released</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.exports as row (row.id)}
        <TableRow>
          <TableCell>{row.id}</TableCell>
          <TableCell>
            <a class={LINK_CLASS} href={userLookupUrl(row.userId, 'basic')}>
              {row.username ?? 'No username'} (#{row.userId})
            </a>
          </TableCell>
          <TableCell>
            {row.status}
            {#if row.status === 'held'}
              <span class="block text-[11px] text-amber-300">Held: contact Legal</span>
            {/if}
            {#if row.error}
              <span class="block max-w-xs truncate text-[11px] text-red-300" title={row.error}
                >{row.error}</span
              >
            {/if}
          </TableCell>
          <TableCell>{row.requestedBy ?? '—'}</TableCell>
          <TableCell>{dateTime(row.createdAt)}</TableCell>
          <TableCell>{row.builtAt ? dateTime(row.builtAt) : '—'}</TableCell>
          <TableCell>
            {row.builtAt ? rowsOf(row).toLocaleString() : '—'}
            {#if unavailableOf(row)}
              <span class="block text-[11px] text-amber-300"
                >{unavailableOf(row)} file(s) partial or unavailable</span
              >
            {/if}
          </TableCell>
          <TableCell>{row.releasedAt ? dateTime(row.releasedAt) : '—'}</TableCell>
          <TableCell>
            {#if releasable(row)}
              <form method="POST" action="?/release" use:enhance={releaseForm.enhance}>
                <input type="hidden" name="exportId" value={row.id} />
                {#if confirming === row.id}
                  <span class="mr-1 text-xs text-red-300">Email the archive link to the account?</span>
                  <Button type="submit" size="sm" disabled={releaseForm.submitting}>Yes, send</Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onclick={() => (confirming = null)}>Cancel</Button
                  >
                {:else}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!data.canRelease}
                    title={data.canRelease ? undefined : denied('user.personalDataExport.release')}
                    onclick={() => (confirming = row.id)}>Release…</Button
                  >
                {/if}
              </form>
            {/if}
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/if}
