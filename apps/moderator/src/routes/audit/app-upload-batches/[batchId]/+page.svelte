<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const itemSrc = (batchId: number, index: number) =>
    `/api/app-upload-batch-blob/${batchId}/${index}`;
</script>

<header class="page-header">
  <h1>Upload Batch</h1>
  <Button variant="outline" size="sm" href="/audit/app-upload-batches">← All batches</Button>
</header>

{#if data.detail.kind === 'unavailable'}
  <p class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
    The upload batch table has not been applied to this database yet.
  </p>
{:else if data.detail.kind === 'ok'}
  {@const batch = data.detail.batch}
  <dl class="mb-5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
    <dt class="text-dark-2">Batch</dt>
    <dd>#{batch.id}</dd>
    <dt class="text-dark-2">User</dt>
    <dd>
      <a class={LINK_CLASS} href="/audit/app-upload-batches?userId={batch.userId}">
        {batch.username ?? 'unknown'} ({batch.userId})
      </a>
    </dd>
    <dt class="text-dark-2">App</dt>
    <dd>
      <a class={LINK_CLASS} href="/audit/app-upload-batches?appBlockId={batch.appBlockId}">
        {batch.blockId}
      </a>
      <span class="text-xs text-dark-2">{batch.appBlockId} · v{batch.version ?? '?'}</span>
    </dd>
    <dt class="text-dark-2">Files</dt>
    <dd>
      {batch.recordedCount} uploaded of {batch.itemCount} declared ({batch.presignCount} upload URLs)
    </dd>
    <dt class="text-dark-2">Started</dt>
    <dd>{dateTime(batch.createdAt)}</dd>
    <dt class="text-dark-2">Expires</dt>
    <dd>{dateTime(batch.expiresAt)}</dd>
  </dl>

  {#if data.detail.items.length === 0}
    <p class="text-sm text-dark-2">No file of this batch was uploaded.</p>
  {:else}
    <ul class="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
      {#each data.detail.items as item (item.index)}
        <li class="flex flex-col gap-1 rounded-lg border border-dark-4 bg-dark-6 p-2">
          {#if item.media === 'image'}
            <img
              src={itemSrc(batch.id, item.index)}
              alt="Item {item.index + 1}"
              loading="lazy"
              class="aspect-square w-full rounded object-cover"
            />
          {:else if item.media === 'video'}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={itemSrc(batch.id, item.index)} controls preload="none" class="w-full rounded"
            ></video>
          {:else if item.media === 'audio'}
            <audio src={itemSrc(batch.id, item.index)} controls preload="none" class="w-full"></audio>
          {:else}
            <p class="text-xs text-dark-2">Not previewable here.</p>
          {/if}
          <a
            class="truncate text-xs {LINK_CLASS}"
            href={itemSrc(batch.id, item.index)}
            target="_blank"
            rel="noopener">#{item.index + 1} · {item.blobKey}</a
          >
        </li>
      {/each}
    </ul>
  {/if}
{/if}
