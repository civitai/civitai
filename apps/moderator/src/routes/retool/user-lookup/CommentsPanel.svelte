<script lang="ts">
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { keepLast } from '$lib/keep-last.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { commentUrl } from '$lib/entity-url';
  import WalkPager from '$lib/components/WalkPager.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { fetchComments, type CommentCursor } from './user-account';
  import CommentList from './CommentList.svelte';

  let {
    userId,
    canBulkAct,
    civitaiUrl,
  }: {
    userId: number;
    canBulkAct: boolean;
    civitaiUrl: string;
  } = $props();

  // The cursors walked so far, so Previous is an index move. The panel remounts per account, so no
  // cursor carries over to the next one.
  let cursors = $state<(CommentCursor | null)[]>([null]);
  let index = $state(0);
  // Bumped by a delete, so the page and its total come back from the server rather than being patched.
  let refreshed = $state(0);
  // Each answer carries the index it was asked for. A failed turn keeps the previous rows on screen,
  // and the pager must keep describing those rather than the page that never arrived.
  const comments = keepLast(() => {
    if (!browser) return null;
    const at = index;
    return fetchComments(userId, cursors[at], refreshed).then((p) => ({ ...p, index: at }));
  });

  // Always a new `cursors`, even going back: after a failed turn `index` may already hold the target,
  // and only a changed source makes `keepLast` ask again.
  const goTo = (from: number, next: CommentCursor | null) => {
    cursors = next ? [...cursors.slice(0, from + 1), next] : cursors.slice(0, Math.max(1, from));
    index = next ? from + 1 : Math.max(0, from - 1);
  };
</script>

<section class="mb-4">
  {#if comments.value}
    {@const p = comments.value}
    <CommentList
      title="Comments"
      rows={p.items}
      total={p.total}
      loading={comments.loading}
      onDeleted={() => refreshed++}
      {userId}
      {canBulkAct}
    >
      {#snippet link(c)}
        <a href={commentUrl(civitaiUrl, c.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
          {c.entityType} {c.entityId}
        </a>
      {/snippet}
      {#snippet footer()}
        {#if comments.failed}
          <ErrorAlert class="mt-3" message="Could not load that page of comments." />
        {/if}
        <WalkPager
          index={p.index}
          hasNext={!!p.next && !comments.loading}
          onBack={() => goTo(p.index, null)}
          onNext={() => goTo(p.index, p.next)}
        />
      {/snippet}
    </CommentList>
  {:else if comments.failed}
    <div class="flex items-center gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-red-300">Could not load comments.</p>
      <Button size="xs" variant="outline" onclick={() => refreshed++}>Retry</Button>
    </div>
  {:else}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading comments…</p>
    </div>
  {/if}
</section>
