<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Avatar, AvatarImage, AvatarFallback } from '@civitai/ui/components/ui/avatar/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Skeleton } from '@civitai/ui/components/ui/skeleton/index.js';
  import { IconChevronLeft, IconChevronRight, IconChevronsLeft } from '@tabler/icons-svelte';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import { civitaiUrl } from '$lib/model-url';
  import type { CollectorPage } from '$lib/analytics/collectors';

  let { endpoint, noun }: { endpoint: string; noun: string } = $props();

  // Distinct from the reactors panel's `after`/`before` so the two lists page independently.
  const PARAMS = ['collectors_after', 'collectors_before'] as const;

  let retry = $state(0);
  let panel: HTMLElement | undefined = $state();

  // Its own string, so a change to the page's other params (the reactors list, the date range) does not refetch.
  const qs = $derived.by(() => {
    const p = new URLSearchParams();
    const after = page.url.searchParams.get('collectors_after');
    const before = page.url.searchParams.get('collectors_before');
    if (after !== null) p.set('after', after);
    if (before !== null) p.set('before', before);
    return p.toString();
  });

  const result = $derived.by(() => {
    void retry;
    if (!browser) return null;
    return fetch(`${endpoint}${qs ? `?${qs}` : ''}`).then((r): Promise<CollectorPage> => {
      if (r.status === 400) throw new Error('This page link is out of date.');
      if (!r.ok) throw new Error(`Something went wrong (${r.status}).`);
      return r.json();
    });
  });

  function navigate(next: Partial<Record<(typeof PARAMS)[number], string | number>>) {
    const p = new URLSearchParams(page.url.searchParams);
    for (const k of PARAMS) p.delete(k);
    for (const [k, v] of Object.entries(next)) if (v != null) p.set(k, String(v));
    const qs = p.toString();
    // The pager unmounts while the next page loads, so focus would fall to <body>.
    return goto(qs ? `${page.url.pathname}?${qs}` : page.url.pathname, {
      keepFocus: true,
      noScroll: true,
    }).then(() => panel?.focus());
  }

  const num = (n: number) => n.toLocaleString();
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
</script>

{#snippet loading()}
  <span class="sr-only">Loading who collected…</span>
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
    {#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
      <div class="flex items-center gap-2 p-1">
        <Skeleton class="size-8 rounded-full" />
        <div class="flex-1 space-y-1">
          <Skeleton class="h-3 w-28" />
          <Skeleton class="h-3 w-16" />
        </div>
      </div>
    {/each}
  </div>
{/snippet}

<section
  bind:this={panel}
  tabindex="-1"
  aria-label="Who collected"
  class="cs-panel mt-4 scroll-mt-4 p-4 outline-none"
>
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
    <p class="text-sm font-medium text-white">
      Who collected
      <span class="text-xs text-dark-2">· only you can see this · all time</span>
    </p>
    <p class="text-xs text-dark-2">Public collections only · newest accounts first</p>
  </div>

  {#if result === null}
    {@render loading()}
  {:else}
    {#await result}
      {@render loading()}
    {:then data}
      {#if data.total === 0}
        <div class="flex h-24 items-center justify-center text-center text-sm text-dark-2">
          Nobody has this {noun} in a public collection yet.
        </div>
      {:else if data.collectors.length === 0}
        <div class="flex h-24 flex-col items-center justify-center gap-2 text-sm text-dark-2">
          No collectors on this page.
          <Button variant="outline" size="sm" onclick={() => navigate({})}>
            Back to the first page
          </Button>
        </div>
      {:else}
        <ul class="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {#each data.collectors as c (c.userId)}
            <li class="flex min-w-0 items-center gap-2 rounded p-1">
              <Avatar class="size-8">
                {#if c.image}<AvatarImage src={getEdgeUrl(c.image, { width: 96 })} alt="" />{/if}
                <AvatarFallback>{(c.username ?? '?').slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-1.5">
                  {#if c.username}
                    <a
                      href={civitaiUrl(`user/${encodeURIComponent(c.username)}`, {})}
                      target="_blank"
                      rel="noreferrer"
                      class="truncate text-sm text-white hover:underline"
                      title={c.username}>{c.username}</a
                    >
                  {:else}
                    <span class="truncate text-sm text-dark-2">Unknown account</span>
                  {/if}
                  {#if c.follows}<Badge variant="outline" class="text-[10px]">Follows you</Badge
                    >{/if}
                  {#if c.banned}<Badge variant="outline" class="text-[10px]">Banned</Badge>{/if}
                </div>
                <p class="text-xs text-dark-2">
                  Collected {date(c.collectedAt)}{c.collections > 1
                    ? ` · ${c.collections} collections`
                    : ''}
                </p>
              </div>
            </li>
          {/each}
        </ul>

        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-dark-2">
          <span>{num(data.total)} collectors · {data.collectors.length} shown</span>
          <div class="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              aria-label="First page"
              disabled={data.prev === null}
              onclick={() => navigate({})}
            >
              <IconChevronsLeft size={13} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={data.prev === null}
              onclick={() => navigate({ collectors_before: data.prev ?? undefined })}
            >
              <IconChevronLeft size={13} /> Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={data.next === null}
              onclick={() => navigate({ collectors_after: data.next ?? undefined })}
            >
              Older <IconChevronRight size={13} />
            </Button>
          </div>
        </div>
      {/if}
    {:catch err}
      <div class="flex h-24 flex-col items-center justify-center gap-2 text-center text-sm">
        <p class="text-red-300">
          Couldn't load who collected. {err instanceof Error ? err.message : ''}
        </p>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" onclick={() => retry++}>Try again</Button>
          {#if PARAMS.some((k) => page.url.searchParams.has(k))}
            <Button variant="outline" size="sm" onclick={() => navigate({})}
              >Back to the first page</Button
            >
          {/if}
        </div>
      </div>
    {/await}
  {/if}
</section>
