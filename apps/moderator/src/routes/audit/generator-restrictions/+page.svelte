<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import { dateTime } from '$lib/format';
  import { urlWith } from '$lib/url';
  import RestrictionFilters from './RestrictionFilters.svelte';
  import RestrictionDetail from './RestrictionDetail.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import Pager from '$lib/components/Pager.svelte';
  import { RESTRICTION_TYPE, RESTRICTION_TYPE_LABELS } from '$lib/restriction-types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const selectHref = (id: number) => urlWith(page.url, { selected: id });
  const pageHref = (n: number) => urlWith(page.url, { page: n, selected: null });

  // Captured BEFORE the ruling's reload: under the default Pending filter the actioned row leaves the
  // list, but under "Any status" it stays, and picking the head would send the moderator back to a row
  // they already handled. The successor is decided from the order they were working.
  let successorId: number | null = $state(null);
  const rememberSuccessor = () => {
    const index = data.items.findIndex((i) => i.id === data.current?.id);
    successorId = (data.items[index + 1] ?? data.items[index - 1])?.id ?? null;
  };

  const advance = () => {
    const next = data.items.find((i) => i.id === successorId) ?? null;
    goto(next ? selectHref(next.id) : urlWith(page.url, { selected: null }), {
      keepFocus: true,
      noScroll: true,
    });
  };
</script>

<header class="page-header">
  <h1>Generator Restrictions</h1>
  {#if data.type === RESTRICTION_TYPE}
    <p>Generation restrictions raised by the prompt-auditing system, and the rulings on them.</p>
  {:else}
    <!-- Named rather than described: the verdict path still sends generation-specific notices, so the
         resolve and ban actions refuse these rows server-side. Saying so here is what stops a
         moderator reading that refusal as a bug. -->
    <p>
      {RESTRICTION_TYPE_LABELS[data.type]} restrictions. Review only — rulings are not yet wired for this
      type.
    </p>
  {/if}
</header>

<RestrictionFilters q={data.q} status={data.status} type={data.type} />

<div class="flex items-start gap-6">
  <div class="flex w-104 shrink-0 flex-col">
    {#if data.items.length === 0}
      <p class="text-sm text-dark-2">
        No {RESTRICTION_TYPE_LABELS[data.type].toLowerCase()} restrictions match these filters.
      </p>
    {:else}
      <ul class="max-h-[70vh] overflow-auto rounded-xl border border-dark-4">
        {#each data.items as item (item.id)}
          <li class="border-b border-dark-4 last:border-b-0">
            <a
              href={selectHref(item.id)}
              class={cn(
                'flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-dark-5',
                data.current?.id === item.id && 'bg-dark-5'
              )}
            >
              <span class="truncate text-dark-0">
                {item.username ?? `User #${item.userId}`}
              </span>
              <span class="flex shrink-0 items-center gap-2">
                <StatusBadge status={item.status} />
                <span class="text-xs text-dark-2">{dateTime(item.createdAt)}</span>
              </span>
            </a>
          </li>
        {/each}
      </ul>

      <Pager page={data.page} pageCount={data.pageCount} total={data.totalCount} href={pageHref} />
    {/if}
  </div>

  <div class="min-w-0 flex-1">
    {#if data.current}
      <!-- Ticked triggers and an open ban confirmation both describe ONE restriction. -->
      {#key data.current.id}
        <RestrictionDetail
          restriction={data.current}
          civitaiUrl={data.civitaiUrl}
          canBan={!!data.grants['audit.ban.execute']}
          canViewGenerations={!!data.grants['user.generations.view']}
          onStart={rememberSuccessor}
          onDone={advance}
        />
      {/key}
    {:else}
      <p class="text-sm text-dark-2">Select a restriction to review its triggers.</p>
    {/if}
  </div>
</div>
