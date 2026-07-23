<script lang="ts">
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import Pagination from '$lib/components/Pagination.svelte';
  import { analyticsPageSize } from '$lib/stores/analytics-page-size';
  import { page as pageState } from '$app/state';
  import { goto } from '$app/navigation';
  import { formatRange } from '$lib/date-range';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);

  // Add a content type here (label + its data array key + singular noun) to give it a tab.
  const TABS = [
    { key: 'images', label: 'Images', singular: 'image' },
    { key: 'videos', label: 'Videos', singular: 'video' },
  ] as const;
  type TabKey = (typeof TABS)[number]['key'];

  // Tab + page both live in the URL so they're linkable and survive reload; switching tab resets to page 1.
  const tab = $derived(
    (TABS.find((t) => t.key === pageState.url.searchParams.get('tab'))?.key ?? 'images') as TabKey
  );
  function setTab(key: string) {
    const p = new URLSearchParams(pageState.url.searchParams);
    if (key === 'images') p.delete('tab');
    else p.set('tab', key);
    p.delete('page');
    const qs = p.toString();
    goto(qs ? `${pageState.url.pathname}?${qs}` : pageState.url.pathname, {
      keepFocus: true,
      noScroll: true,
    });
  }

  const active = $derived(TABS.find((t) => t.key === tab)!);
  const pageSize = $derived(analyticsPageSize.value);
  const items = $derived(data[tab]);
  const total = $derived(items?.length ?? 0);
  const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
  const pageNum = $derived(Math.max(1, Number(pageState.url.searchParams.get('page')) || 1));
  const curPage = $derived(Math.min(pageNum, totalPages));
  const shown = $derived(items ? items.slice((curPage - 1) * pageSize, curPage * pageSize) : []);
</script>

<AnalyticsHeader range={data.range} compare={data.compare} showCompare={false} />

<div class="mb-4">
  <ToggleGroup
    type="single"
    value={tab}
    onValueChange={(v: string) => {
      if (v) setTab(v);
    }}
    variant="outline"
    size="sm"
  >
    {#each TABS as t (t.key)}
      <ToggleGroupItem value={t.key} class="text-xs">{t.label}</ToggleGroupItem>
    {/each}
  </ToggleGroup>
</div>

{#if items === null}
  <div class="placeholder">{active.label} are temporarily unavailable — please try again shortly.</div>
{:else if items.length === 0}
  <div class="placeholder">No {active.singular} reactions {periodLabel} yet.</div>
{:else}
  <p class="mb-3 text-sm font-medium text-white">
    Top {tab} by reactions <span class="text-xs text-dark-3">{periodLabel}</span>
  </p>
  <div class="mb-3">
    <Pagination {total} noun={active.singular} {curPage} {totalPages} />
  </div>
  <div class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
    {#each shown as m, i (m.imageId)}
      <!-- mature (nsfwLevel > 3) links to civitai.red -->
      <a
        href="https://civitai.{m.nsfwLevel > 3 ? 'red' : 'com'}/images/{m.imageId}"
        target="_blank"
        rel="noreferrer"
        class="group relative block aspect-square overflow-hidden rounded-lg border border-dark-4 bg-dark-7"
      >
        <EdgeMedia
          src={m.url}
          type={m.type}
          width={450}
          alt="Top {active.singular} #{m.imageId}"
          class="h-full w-full object-cover transition-transform group-hover:scale-105"
        />
        <div class="absolute inset-x-0 top-0 flex justify-start bg-linear-to-b from-black/60 to-transparent px-2 py-1">
          <span class="text-xs font-semibold text-white">#{(curPage - 1) * pageSize + i + 1}</span>
        </div>
        <div class="absolute inset-x-0 bottom-0 flex justify-end bg-linear-to-t from-black/70 to-transparent px-2 py-1.5">
          <span class="text-xs font-semibold text-white">♥ {num(m.reactions)}</span>
        </div>
      </a>
    {/each}
  </div>
  {#if totalPages > 1}
    <div class="mt-4">
      <Pagination {total} noun={active.singular} {curPage} {totalPages} />
    </div>
  {/if}
{/if}
