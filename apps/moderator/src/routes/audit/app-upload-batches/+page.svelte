<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import { urlWith } from '$lib/url';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
</script>

<header class="page-header">
  <h1>App Upload Batches</h1>
  <p>
    Private files apps uploaded for a viewer in one confirmed batch. The files are kept for at least
    30 days from when the batch started.
  </p>
</header>

<form method="GET" class="mb-4 flex flex-wrap items-end gap-3">
  <label class="flex flex-col gap-1 text-xs text-dark-2">
    User id
    <Input name="userId" inputmode="numeric" value={data.filter.userId ?? ''} class="w-36" />
  </label>
  <label class="flex flex-col gap-1 text-xs text-dark-2">
    App block id
    <Input name="appBlockId" value={data.filter.appBlockId ?? ''} class="w-72" />
  </label>
  <Button type="submit" size="sm">Search</Button>
  {#if data.filter.userId !== null || data.filter.appBlockId !== null}
    <Button variant="outline" size="sm" href="/audit/app-upload-batches">Clear</Button>
  {/if}
</form>

{#if data.list.kind === 'unavailable'}
  <p class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
    The upload batch table has not been applied to this database yet, so there is nothing to show.
  </p>
{:else if data.list.items.length === 0}
  <p class="text-sm text-dark-2">No batches match.</p>
{:else}
  <table class="w-full text-left text-sm">
    <thead class="text-xs text-dark-2">
      <tr>
        <th class="py-2 pr-3">Batch</th>
        <th class="py-2 pr-3">Started</th>
        <th class="py-2 pr-3">User</th>
        <th class="py-2 pr-3">App</th>
        <th class="py-2 pr-3">Files</th>
        <th class="py-2 pr-3">Size</th>
        <th class="py-2 pr-3">Expires</th>
      </tr>
    </thead>
    <tbody>
      {#each data.list.items as batch (batch.id)}
        <tr class="border-t border-dark-4">
          <td class="py-2 pr-3">
            <a class={LINK_CLASS} href="/audit/app-upload-batches/{batch.id}">#{batch.id}</a>
          </td>
          <td class="py-2 pr-3">{dateTime(batch.createdAt)}</td>
          <td class="py-2 pr-3">
            <a class={LINK_CLASS} href={urlWith(page.url, { userId: batch.userId, cursor: null })}>
              {batch.username ?? 'unknown'} ({batch.userId})
            </a>
          </td>
          <td class="py-2 pr-3">
            <a
              class={LINK_CLASS}
              href={urlWith(page.url, { appBlockId: batch.appBlockId, cursor: null })}
            >
              {batch.blockId}
            </a>
            <span class="text-xs text-dark-2">{batch.appBlockId} · v{batch.version ?? '?'}</span>
          </td>
          <td class="py-2 pr-3">{batch.recordedCount} / {batch.itemCount}</td>
          <td class="py-2 pr-3">{mb(batch.totalBytes)}</td>
          <td class="py-2 pr-3">{dateTime(batch.expiresAt)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <CursorPager
    href={data.list.nextCursor ? urlWith(page.url, { cursor: data.list.nextCursor }) : null}
  />
{/if}
