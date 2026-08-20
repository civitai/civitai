<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import type { PageData } from './$types';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { reportStatusVariant } from '$lib/reports';
  import { userLookupUrl } from '$lib/entity-url';

  let {
    history,
    truncated,
  }: { history: PageData['history']; truncated: boolean } = $props();

  const SHOWN = 20;
  let expanded = $state(false);
  const visible = $derived(expanded ? history : history.slice(0, SHOWN));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">
    Recently resolved ({history.length}{truncated ? '+' : ''})
  </h2>
  <p class="mb-3 text-xs text-dark-2">
    Who has been working this queue, so two moderators do not action the same account twice.
  </p>

  {#if history.length === 0}
    <p class="text-sm text-dark-2">Nothing resolved yet.</p>
  {:else}
    <ul class="space-y-1 text-sm">
      {#each visible as h (h.id)}
        <li class="flex flex-wrap items-baseline gap-x-2">
          <Badge variant={reportStatusVariant(h.status)}>{h.status}</Badge>
          {#if h.entityId}
            <a href={userLookupUrl(h.suspect?.username ?? h.entityId)} class={LINK_CLASS}>
              {h.suspect?.username ?? `#${h.entityId}`}
            </a>
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
