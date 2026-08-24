<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import type { PageData } from './$types';
  import { page as pageState } from '$app/state';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { reportStatusVariant } from '$lib/reports';
  import { userLookupUrl } from '$lib/entity-url';

  let { history, truncated }: { history: PageData['history']; truncated: boolean } = $props();

  // Merged into the current params, never a bare `?post=`: that replaces the whole query string, so
  // opening a resolved post from here would silently reset the queue to page 1 with the default filters.
  const postHref = (entityId: number) => {
    const params = new URLSearchParams(pageState.url.search);
    params.set('post', String(entityId));
    return `?${params}`;
  };

  const SHOWN = 20;
  let expanded = $state(false);
  const visible = $derived(expanded ? history : history.slice(0, SHOWN));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">
    Recently resolved ({history.length}{truncated ? '+' : ''})
  </h2>
  <p class="mb-3 text-xs text-dark-2">
    Who has been working this queue, so two moderators do not action the same post twice.
  </p>

  {#if history.length === 0}
    <p class="text-sm text-dark-2">Nothing resolved yet.</p>
  {:else}
    <ul class="space-y-1 text-sm">
      {#each visible as h (h.id)}
        <li class="flex flex-wrap items-baseline gap-x-2">
          <Badge variant={reportStatusVariant(h.status)}>{h.status}</Badge>
          {#if h.entityId}
            <a href={postHref(h.entityId)} class={LINK_CLASS}>Post #{h.entityId}</a>
          {/if}
          {#if h.post?.username}
            <a href={userLookupUrl(h.post.username)} class={LINK_CLASS}>{h.post.username}</a>
          {/if}
          <span class="text-xs text-dark-2">by {h.moderator ?? 'unknown'}</span>
          <span class="text-xs text-dark-2">{dateTime(h.statusSetAt)}</span>
        </li>
      {/each}
    </ul>
    <ShowMoreButton
      total={history.length}
      shown={SHOWN}
      {expanded}
      capped={truncated}
      onToggle={() => (expanded = !expanded)}
    />
  {/if}
</section>
