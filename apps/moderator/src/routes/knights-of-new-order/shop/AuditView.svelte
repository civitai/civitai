<script lang="ts">
  import { IconHistory } from '@tabler/icons-svelte';
  import * as Empty from '@civitai/ui/components/ui/empty/index.js';
  import { urlWith } from '$lib/url';
  import AuditFilter from './AuditFilter.svelte';
  import AuditTimeline from './AuditTimeline.svelte';
  import type { AuditRow } from './audit';

  let {
    items,
    itemId,
    before,
    nextBefore,
    changes,
    url,
    onopenitem,
  }: {
    items: { id: number; name: string }[];
    itemId: string;
    before: number | null;
    nextBefore: number | null;
    changes: readonly AuditRow[];
    url: URL;
    onopenitem: (id: number) => void;
  } = $props();
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-5 flex flex-wrap items-center gap-3">
    <AuditFilter {items} {itemId} {url} />
  </div>
  {#if changes.length}
    <AuditTimeline rows={changes} {onopenitem} />
    {#if before !== null || nextBefore !== null}
      <p class="mt-6 flex gap-4 text-sm">
        {#if before !== null}
          <a class="text-blue-4 hover:underline" href={urlWith(url, { before: null })}>
            Newest changes
          </a>
        {/if}
        {#if nextBefore !== null}
          <a class="text-blue-4 hover:underline" href={urlWith(url, { before: nextBefore })}>
            Older changes
          </a>
        {/if}
      </p>
    {/if}
  {:else}
    <Empty.Root class="py-10">
      <Empty.Header>
        <Empty.Media variant="icon"><IconHistory /></Empty.Media>
        <Empty.Title>No changes recorded</Empty.Title>
        <Empty.Description>
          Adding, editing, retiring and restoring items shows up here.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {/if}
</section>
