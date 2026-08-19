<script lang="ts">
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import Pagination from '$lib/components/Pagination.svelte';
  import { analyticsPageSize } from '$lib/stores/analytics-page-size';
  import { page as pageState } from '$app/state';
  import { goto } from '$app/navigation';
  import { formatRange } from '$lib/date-range';
  import { civitaiUrl } from '$lib/model-url';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import ImpressionsNotice from '$lib/components/ImpressionsNotice.svelte';
  import {
    IconEye,
    IconExternalLink,
    IconLayoutGrid,
    IconHeart,
    IconBook,
  } from '@tabler/icons-svelte';
  import type { TopImage } from '$lib/server/analytics';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  // The tile overlay holds three metrics inside a square that is ~90px wide on mobile; at full precision the
  // row overflows and, being justify-end, the clipped one is impressions.
  const compactFmt = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const compact = (n: number) => compactFmt.format(n);
  const periodLabel = $derived(`for ${formatRange(data.range)}`);

  // Add a content type here (label + its data array key + singular noun) to give it a tab.
  const TABS = [
    { key: 'images', label: 'Images', singular: 'image' },
    { key: 'videos', label: 'Videos', singular: 'video' },
    { key: 'articles', label: 'Articles', singular: 'article' },
    { key: 'comics', label: 'Comics', singular: 'comic' },
    { key: 'model3ds', label: '3D models', singular: '3D model' },
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
    // Comics have no impressions to rank by, so carrying that sort across would leave the control with
    // nothing selected while the list quietly fell back to reads.
    if (key === 'comics' && p.get('sort') === 'impressions') p.delete('sort');
    p.delete('page');
    const qs = p.toString();
    goto(qs ? `${pageState.url.pathname}?${qs}` : pageState.url.pathname, {
      keepFocus: true,
      noScroll: true,
    });
  }

  // 3D models carry views only, so the rank-by control is hidden there rather than shown inert.
  const isArticles = $derived(tab === 'articles');
  const isComics = $derived(tab === 'comics');
  const is3d = $derived(tab === 'model3ds');
  const isMedia = $derived(!isArticles && !isComics && !is3d);

  // Ranking is client-side: the server already caps each tab at 100 rows, and re-sorting them costs nothing
  // next to a second round trip. It does mean "top by views" ranks within the top-100 *by reactions* — a
  // much-viewed image nobody reacted to isn't in the list to be ranked. Noted on the page.
  // Ordered widest-funnel first — impressions, then views, then reactions — and the cards carry the same three
  // in the same order behind the same icons, so the control doubles as the legend for them.
  const SORTS = [
    { key: 'impressions', label: 'Impressions', icon: IconLayoutGrid },
    { key: 'views', label: 'Views', icon: IconEye },
    { key: 'reactions', label: 'Reactions', icon: IconHeart },
  ] as const;
  type SortKey = (typeof SORTS)[number]['key'];
  const sort = $derived(
    (SORTS.find((s) => s.key === pageState.url.searchParams.get('sort'))?.key ??
      'reactions') as SortKey
  );
  function setSort(key: string) {
    const p = new URLSearchParams(pageState.url.searchParams);
    if (key === 'reactions') p.delete('sort');
    else p.set('sort', key);
    p.delete('page');
    const qs = p.toString();
    goto(qs ? `${pageState.url.pathname}?${qs}` : pageState.url.pathname, {
      keepFocus: true,
      noScroll: true,
    });
  }

  const active = $derived(TABS.find((t) => t.key === tab)!);
  const pageSize = $derived(analyticsPageSize.value);

  const media = $derived(
    !isMedia || data[tab] === null
      ? null
      : sort === 'views'
        ? [...(data[tab] as TopImage[])].sort((a, b) => b.views - a.views)
        : sort === 'impressions'
          ? [...(data[tab] as TopImage[])].sort((a, b) => b.impressions - a.impressions)
          : (data[tab] as TopImage[])
  );
  const articles = $derived(
    data.articles === null
      ? null
      : sort === 'views'
        ? [...data.articles].sort((a, b) => b.views - a.views)
        : sort === 'impressions'
          ? [...data.articles].sort((a, b) => b.impressions - a.impressions)
          : [...data.articles].sort((a, b) => b.reactions - a.reactions)
  );
  // Comics and 3D models arrive wrapped in a panel carrying a `tracking` flag, so that "nothing collected
  // yet" can be told apart from "you have none" — their ClickHouse tables are live but stay empty until the
  // emitting code deploys and the backfill runs.
  const comics = $derived.by(() => {
    const list = data.comics?.comics ?? null;
    if (!list) return null;
    // Comics rank by views vs chapter READS, not reactions: the `reactions` type enum has no Comic arm, so
    // there is no reaction count to sort on. `sort` is shared with the other tabs, and its 'reactions' value
    // maps to reads here — the control is relabelled rather than given a third vocabulary.
    return sort === 'views'
      ? [...list].sort((a, b) => b.projectViews - a.projectViews)
      : [...list].sort((a, b) => b.chapterReads - a.chapterReads);
  });
  const model3ds = $derived(data.model3ds?.models ?? null);
  const trackingLive = $derived(
    isComics ? (data.comics?.tracking ?? false) : is3d ? (data.model3ds?.tracking ?? false) : true
  );
  // One paging model over whichever list this tab is showing; only the card markup differs.
  const activeList = $derived(is3d ? model3ds : isComics ? comics : isArticles ? articles : media);
  const unavailable = $derived(
    is3d
      ? data.model3ds === null
      : isComics
        ? data.comics === null
        : isArticles
          ? articles === null
          : data[tab] === null
  );
  const total = $derived(activeList?.length ?? 0);
  const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
  const pageNum = $derived(Math.max(1, Number(pageState.url.searchParams.get('page')) || 1));
  const curPage = $derived(Math.min(pageNum, totalPages));
  const slice = <T,>(xs: T[] | null) =>
    xs ? xs.slice((curPage - 1) * pageSize, curPage * pageSize) : [];
  const shown = $derived(slice(media));
  const shownArticles = $derived(slice(articles));
  const shownComics = $derived(slice(comics));
  const shown3d = $derived(slice(model3ds));
</script>

<AnalyticsHeader range={data.range} compare={data.compare} showCompare={false} />

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
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

  {#if !is3d}
    <div class="flex items-center gap-2">
      <span class="text-xs text-dark-3">Rank by</span>
      <ToggleGroup
        type="single"
        value={sort}
        onValueChange={(v: string) => {
          if (v) setSort(v);
        }}
        variant="outline"
        size="sm"
      >
        <!-- Comics are not feed entities, so they have no impressions to rank by — the option is omitted
             there rather than shown ranking everything at zero. -->
        {#each SORTS.filter((s) => !(isComics && s.key === 'impressions')) as s (s.key)}
          {@const ReadsIcon = isComics && s.key === 'reactions' ? IconBook : s.icon}
          <ToggleGroupItem value={s.key} class="gap-1 text-xs">
            <ReadsIcon size={13} />
            {isComics && s.key === 'reactions' ? 'Reads' : s.label}
          </ToggleGroupItem>
        {/each}
      </ToggleGroup>
    </div>
  {/if}
</div>

{#if !isComics && !is3d}
  <ImpressionsNotice />
{/if}

{#if unavailable}
  <div class="placeholder">
    {active.label} are temporarily unavailable — please try again shortly.
  </div>
{:else if total === 0}
  <div class="placeholder">
    {#if is3d}
      You haven't published a 3D model yet.
    {:else if isComics}
      You haven't published a comic yet.
    {:else if isArticles}
      No article views {periodLabel} yet.
    {:else}
      No {active.singular} reactions {periodLabel} yet.
    {/if}
  </div>
{:else}
  <p class="mb-3 text-sm font-medium text-white">
    {#if is3d}
      Your 3D models
      <span class="text-xs text-dark-3">
        {trackingLive ? `· by views ${periodLabel}` : '· view tracking wasn’t collecting yet then'}
      </span>
    {:else if isComics}
      Your comics by {sort === 'views' ? 'views' : 'chapter reads'}
      <span class="text-xs text-dark-3">
        {trackingLive ? `· ${periodLabel}` : '· by readers, not views'}
      </span>
    {:else}
      Top {tab} by {sort === 'views'
        ? 'views'
        : sort === 'impressions'
          ? 'impressions'
          : 'reactions'}
      <span class="text-xs text-dark-3">
        {periodLabel}{isMedia && sort !== 'reactions' ? ' · within your 100 most-reacted' : ''}
      </span>
    {/if}
  </p>
  <div class="mb-3">
    <Pagination {total} noun={active.singular} {curPage} {totalPages} />
  </div>

  {#if is3d}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each shown3d as m (m.model3dId)}
        <a
          href="/analytics/content/model3d/{m.model3dId}"
          class="group flex gap-3 overflow-hidden rounded-lg border border-dark-4 bg-dark-7 p-2"
        >
          <div class="size-16 shrink-0 overflow-hidden rounded bg-dark-6">
            {#if m.coverUrl}
              <EdgeMedia
                src={m.coverUrl}
                type="image"
                width={160}
                alt=""
                class="h-full w-full object-cover"
              />
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-white" title={m.name}>{m.name}</p>
            <p class="mt-1 flex items-center gap-1 text-xs text-dark-2">
              {#if trackingLive}
                <IconEye size={13} />
                {num(m.views)} views {periodLabel}
              {:else}
                <span class="text-dark-2">Not tracked yet {periodLabel}</span>
              {/if}
            </p>
            {#if !m.published}
              <p class="text-xs text-dark-4">unpublished</p>
            {/if}
          </div>
          <IconExternalLink
            size={14}
            class="mt-1 shrink-0 text-dark-4 transition-colors group-hover:text-white"
          />
        </a>
      {/each}
    </div>
  {:else if isComics}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each shownComics as c, i (c.projectId)}
        <a
          href="/analytics/content/comic/{c.projectId}"
          class="group flex gap-3 overflow-hidden rounded-lg border border-dark-4 bg-dark-7 p-2"
        >
          <div class="size-16 shrink-0 overflow-hidden rounded bg-dark-6">
            {#if c.coverUrl}
              <EdgeMedia
                src={c.coverUrl}
                type="image"
                width={160}
                alt=""
                class="h-full w-full object-cover"
              />
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-white" title={c.name}>
              <span class="text-dark-2">#{(curPage - 1) * pageSize + i + 1}</span>
              {c.name}
            </p>
            <p class="mt-1 flex items-center gap-2 text-xs text-dark-2">
              {#if trackingLive}
                <span
                  class="flex items-center gap-1"
                  title="Views of this comic's overview page {periodLabel}"
                >
                  <IconEye size={13} />
                  {num(c.projectViews)}
                </span>
                <span class="flex items-center gap-1" title="Chapter reads {periodLabel}">
                  <IconBook size={13} />
                  {num(c.chapterReads)}
                </span>
              {:else}
                <span class="flex items-center gap-1" title="Readers, all time">
                  <IconBook size={13} />
                  {num(c.readers)}
                </span>
                <span>{num(c.newReaders)} new {periodLabel}</span>
              {/if}
            </p>
            <p class="text-xs text-dark-3">
              {c.chapters}
              {c.chapters === 1 ? 'chapter' : 'chapters'}
              {#if !c.published}· <span class="text-dark-4">unpublished</span>{/if}
            </p>
          </div>
        </a>
      {/each}
    </div>
  {:else if isArticles}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each shownArticles as a, i (a.articleId)}
        <!-- Same rule as the media tiles: the card opens the Studio's own history for this article, and the
             public page is a deliberate second click from the detail view. -->
        <a
          href="/analytics/content/article/{a.articleId}"
          class="group flex gap-3 overflow-hidden rounded-lg border border-dark-4 bg-dark-7 p-2"
        >
          <div class="size-16 shrink-0 overflow-hidden rounded bg-dark-6">
            {#if a.coverUrl}
              <EdgeMedia
                src={a.coverUrl}
                type="image"
                width={160}
                alt=""
                class="h-full w-full object-cover"
              />
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-white" title={a.title}>
              <span class="text-dark-2">#{(curPage - 1) * pageSize + i + 1}</span>
              {a.title}
            </p>
            <p class="mt-1 flex items-center gap-2 text-xs text-dark-2">
              <span class="flex items-center gap-1" title="Feed impressions {periodLabel}">
                <IconLayoutGrid size={13} />
                {num(a.impressions)}
              </span>
              <span class="flex items-center gap-1" title="Views {periodLabel}">
                <IconEye size={13} />
                {num(a.views)}
              </span>
              <span class="flex items-center gap-1" title="Reactions {periodLabel}">
                <IconHeart size={13} />
                {num(a.reactions)}
              </span>
            </p>
            {#if a.publishedAt}
              <p class="text-xs text-dark-3">Published {a.publishedAt.slice(0, 10)}</p>
            {/if}
          </div>
        </a>
      {/each}
    </div>
  {:else}
    <div class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
      {#each shown as m, i (m.imageId)}
        <!-- The tile now opens this image's view history rather than leaving the Studio; the corner icon keeps
           the old escape hatch to the public page; mature content lives on civitai.red. -->
        <div
          class="group relative aspect-square overflow-hidden rounded-lg border border-dark-4 bg-dark-7"
        >
          <a href="/analytics/content/image/{m.imageId}" class="block h-full w-full">
            <EdgeMedia
              src={m.url}
              type={m.type}
              width={450}
              alt="Top {active.singular} #{m.imageId}"
              class="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
            <div
              class="absolute inset-x-0 top-0 flex justify-start bg-linear-to-b from-black/60 to-transparent px-2 py-1"
            >
              <span class="text-xs font-semibold text-white"
                >#{(curPage - 1) * pageSize + i + 1}</span
              >
            </div>
            <div
              class="absolute inset-x-0 bottom-0 flex flex-wrap justify-end gap-x-2 bg-linear-to-t from-black/70 to-transparent px-2 py-1.5"
            >
              <span class="text-xs font-semibold text-white" title="Feed impressions {periodLabel}">
                <IconLayoutGrid size={12} class="inline align-[-2px]" />
                {compact(m.impressions)}
              </span>
              <span class="text-xs font-semibold text-white" title="Views {periodLabel}">
                <IconEye size={12} class="inline align-[-2px]" />
                {compact(m.views)}
              </span>
              <span class="text-xs font-semibold text-white" title="Reactions {periodLabel}">
                <IconHeart size={12} class="inline align-[-2px]" />
                {compact(m.reactions)}
              </span>
            </div>
          </a>
          <a
            href={civitaiUrl(`images/${m.imageId}`, m)}
            target="_blank"
            rel="noreferrer"
            aria-label="View {active.singular} #{m.imageId} on Civitai"
            class="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
          >
            <IconExternalLink size={13} />
          </a>
        </div>
      {/each}
    </div>
  {/if}
  {#if totalPages > 1}
    <div class="mt-4">
      <Pagination {total} noun={active.singular} {curPage} {totalPages} />
    </div>
  {/if}
{/if}
