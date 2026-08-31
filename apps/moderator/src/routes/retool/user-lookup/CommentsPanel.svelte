<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS } from '$lib/format';
  import { commentV2Url, entityUrl, modelCommentUrl } from '$lib/entity-url';
  import type { Account } from './user-account';
  import CommentList from './CommentList.svelte';

  let {
    account,
    userId,
    canAct,
    civitaiUrl,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    civitaiUrl: string;
  } = $props();

  const modelUrl = (modelId: number | null, commentId: number) =>
    modelId ? modelCommentUrl(civitaiUrl, modelId, commentId) : null;
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  {#await account}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading comments…</p>
    </div>
  {:then result}
    {#if result}
      <CommentList
        title="Model comments"
        rows={result.comments.items}
        truncated={result.comments.truncated}
        field="commentIds"
        {userId}
        {canAct}
      >
        {#snippet link(c)}
          {#if modelUrl(c.modelId, c.id)}
            <a href={modelUrl(c.modelId, c.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
              model {c.modelId}
            </a>
          {/if}
        {/snippet}
        {#snippet badges(c)}
          {#if c.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
          {#if c.nsfw}<Badge variant="secondary">nsfw</Badge>{/if}
        {/snippet}
      </CommentList>

      <!-- Retool's "Other Comments" half: image, article, bounty and post threads. -->
      <CommentList
        title="Other comments"
        rows={result.commentsV2.items}
        truncated={result.commentsV2.truncated}
        field="commentV2Ids"
        {userId}
        {canAct}
      >
        {#snippet link(c)}
          <!-- Always linkable, even for an entity type with no page of its own: the resolver works
               from the comment id, so the label degrades but the link does not. -->
          <a href={commentV2Url(civitaiUrl, c.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
            {#if entityUrl(civitaiUrl, c.entityType, c.entityId)}
              {c.entityType} {c.entityId}
            {:else}
              thread {c.threadId}
            {/if}
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
