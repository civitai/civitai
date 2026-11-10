<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS } from '$lib/format';
  import { commentUrl } from '$lib/entity-url';
  import type { Account } from './user-account';
  import CommentList from './CommentList.svelte';

  let {
    account,
    userId,
    canBulkAct,
    civitaiUrl,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canBulkAct: boolean;
    civitaiUrl: string;
  } = $props();
</script>

<section class="mb-4">
  {#await account}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading comments…</p>
    </div>
  {:then result}
    {#if result}
      <CommentList
        title="Comments"
        rows={result.comments.items}
        truncated={result.comments.truncated}
        {userId}
        {canBulkAct}
      >
        {#snippet link(c)}
          <a href={commentUrl(civitaiUrl, c.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
            {c.entityType} {c.entityId}
          </a>
        {/snippet}
        {#snippet badges(c)}
          {#if c.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
        {/snippet}
      </CommentList>
    {/if}
  {:catch}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-red-300">Could not load comments.</p>
    </div>
  {/await}
</section>
