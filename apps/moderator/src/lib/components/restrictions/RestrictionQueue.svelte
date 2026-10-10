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
  import AgeBadge from '$lib/components/AgeBadge.svelte';
  import { RESTRICTION_TYPE_LABELS, type RestrictionType } from '$lib/restriction-types';
  import type { RestrictionRow } from '$lib/server/user-restriction.service';

  type QueueData = {
    items: RestrictionRow[];
    current: RestrictionRow | null;
    totalCount: number;
    page: number;
    pageCount: number;
    type: RestrictionType;
    status: string;
    q: string;
    civitaiUrl: string;
    grants: Record<string, boolean | undefined>;
  };

  // `types` is the type picker's options; a queue fixed to one type omits it and shows no picker.
  let {
    data,
    types,
    fallbackType,
  }: { data: QueueData; types?: readonly RestrictionType[]; fallbackType?: RestrictionType } =
    $props();

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


<RestrictionFilters q={data.q} status={data.status} type={data.type} {types} fallbackType={fallbackType ?? data.type} />

<!-- A fixed-width pane here does not stack below `lg`; pinned by
     `src/__tests__/two-pane-stacking.test.ts`, which finds this container by `data-two-pane`. -->
<div data-two-pane class="grid items-start gap-6 lg:grid-cols-[26rem_1fr]">
  <div data-pane class="flex min-w-0 flex-col">
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
                {#if item.status === 'Pending'}
                  <AgeBadge since={item.createdAt} />
                {:else}
                  <span class="text-xs text-dark-2">{dateTime(item.createdAt)}</span>
                {/if}
              </span>
            </a>
          </li>
        {/each}
      </ul>

      <Pager page={data.page} pageCount={data.pageCount} total={data.totalCount} href={pageHref} />
    {/if}
  </div>

  <div data-pane class="min-w-0">
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
