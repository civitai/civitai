<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { PageData } from './$types';

  let { reports, chatId }: { reports: PageData['reports']; chatId: number | null } = $props();

  const SHOWN = 10;
  let expanded = $state(false);
  const visible = $derived(expanded ? reports : reports.slice(0, SHOWN));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Reported chats ({reports.length})</h3>
  <p class="mb-3 text-xs text-dark-2">
    Newest first. Automated reports are excluded — these are ones a person filed.
  </p>

  {#if reports.length === 0}
    <p class="text-sm text-dark-2">No reported chats.</p>
  {:else}
    <ul class="space-y-1.5 text-sm">
      {#each visible as r (r.reportId)}
        <li
          class="flex flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1 {r.chatId === chatId
            ? 'bg-dark-5'
            : ''}"
        >
          <Badge variant={r.status === 'Actioned' ? 'destructive' : 'secondary'}>{r.status}</Badge>
          <a href="?chat={r.chatId}" class={LINK_CLASS}>chat {r.chatId}</a>
          <span class="text-dark-0">{r.reason}</span>
          {#if r.reportedBy}
            <a href="/retool/user-lookup?q={r.reportedById}" class="text-xs {LINK_CLASS}">
              by {r.reportedBy}
            </a>
          {/if}
          <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
          {#if r.comment}
            <span class="w-full truncate text-xs text-dark-2">{r.comment}</span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if reports.length > SHOWN}
      <button type="button" class="mt-3 text-sm {LINK_CLASS}" onclick={() => (expanded = !expanded)}>
        {expanded ? 'Show less' : `Show all ${reports.length}`}
      </button>
    {/if}
  {/if}
</section>
