<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Avatar, AvatarImage, AvatarFallback } from '@civitai/ui/components/ui/avatar/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Skeleton } from '@civitai/ui/components/ui/skeleton/index.js';
  import * as ToggleGroup from '@civitai/ui/components/ui/toggle-group/index.js';
  import { IconChevronLeft, IconChevronRight, IconChevronsLeft } from '@tabler/icons-svelte';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import { civitaiUrl } from '$lib/model-url';
  import { REACTOR_TYPES, type ReactorPage, type ReactorType } from '$lib/analytics/reactors';

  let { endpoint, noun }: { endpoint: string; noun: string } = $props();

  const EMOJI: Record<ReactorType, string> = { Like: '👍', Heart: '❤️', Laugh: '😂', Cry: '😢' };
  const PARAMS = ['reaction', 'after', 'before'] as const;

  let retry = $state(0);
  let panel: HTMLElement | undefined = $state();

  const query = $derived.by(() => {
    const p = new URLSearchParams();
    for (const k of PARAMS) {
      const v = page.url.searchParams.get(k);
      if (v !== null) p.set(k, v);
    }
    return p.toString();
  });

  const result = $derived.by(() => {
    void retry;
    if (!browser) return null;
    return fetch(`${endpoint}${query ? `?${query}` : ''}`).then((r): Promise<ReactorPage> => {
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
    // The tabs and pager unmount while the next page loads, so focus would fall to <body>.
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
  <span class="sr-only">Loading who reacted…</span>
  <div class="mb-3 flex gap-1" aria-hidden="true">
    {#each REACTOR_TYPES as t (t)}<Skeleton class="h-8 w-20" />{/each}
  </div>
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
    {#each Array.from({ length: 9 }, (_, i) => i) as i (i)}
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
  aria-label="Who reacted"
  class="cs-panel mt-4 scroll-mt-4 p-4 outline-none"
>
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
    <p class="text-sm font-medium text-white">
      Who reacted
      <span class="text-xs text-dark-2">· only you can see this · all time</span>
    </p>
    <p class="text-xs text-dark-2">Newest accounts first</p>
  </div>

  {#if result === null}
    {@render loading()}
  {:else}
    {#await result}
      {@render loading()}
    {:then data}
      {@const total = REACTOR_TYPES.reduce((s, t) => s + data.counts[t], 0)}
      {#if total === 0 || !data.reaction}
        <div class="flex h-32 items-center justify-center text-center text-sm text-dark-2">
          No reactions to show on this {noun} yet.
        </div>
      {:else}
        <ToggleGroup.Root
          type="single"
          variant="outline"
          size="sm"
          spacing={1}
          bind:value={() => data.reaction ?? '', (v) => v && navigate({ reaction: v })}
          aria-label="Reaction type"
          class="mb-3 flex-wrap"
        >
          {#each REACTOR_TYPES as t (t)}
            <ToggleGroup.Item value={t} disabled={data.counts[t] === 0}>
              <span aria-hidden="true">{EMOJI[t]}</span>
              {t}
              <span class="text-dark-2">{num(data.counts[t])}</span>
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>

        {#if data.reactors.length === 0}
          <div class="flex h-32 flex-col items-center justify-center gap-2 text-sm text-dark-2">
            No reactors on this page.
            <!-- A tab nobody used has no first page of its own; let the server pick one that does. -->
            <Button
              variant="outline"
              size="sm"
              onclick={() =>
                data.reaction && data.counts[data.reaction] > 0
                  ? navigate({ reaction: data.reaction })
                  : navigate({})}
            >
              Back to the first page
            </Button>
          </div>
        {:else}
          <ul class="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {#each data.reactors as r (r.userId)}
              <li class="flex min-w-0 items-center gap-2 rounded p-1">
                <Avatar class="size-8">
                  {#if r.image}<AvatarImage src={getEdgeUrl(r.image, { width: 96 })} alt="" />{/if}
                  <AvatarFallback>{(r.username ?? '?').slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-1.5">
                    {#if r.deleted || !r.username}
                      <span class="truncate text-sm text-dark-2">Deleted account</span>
                    {:else}
                      <a
                        href={civitaiUrl(`user/${encodeURIComponent(r.username)}`, {})}
                        target="_blank"
                        rel="noreferrer"
                        class="truncate text-sm text-white hover:underline"
                        title={r.username}>{r.username}</a
                      >
                    {/if}
                    {#if r.follows}<Badge variant="outline" class="shrink-0 text-[10px]"
                        >Follows you</Badge
                      >{/if}
                    {#if r.banned && !r.deleted}<Badge variant="outline" class="text-[10px]"
                        >Banned</Badge
                      >{/if}
                  </div>
                  <p class="text-xs text-dark-2">Reacted {date(r.reactedAt)}</p>
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-dark-2">
          <span>
            {num(data.counts[data.reaction])}
            {EMOJI[data.reaction]} reactions · {data.reactors.length} shown
          </span>
          <div class="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              aria-label="First page"
              disabled={data.prev === null}
              onclick={() => navigate({ reaction: data.reaction ?? undefined })}
            >
              <IconChevronsLeft size={13} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={data.prev === null}
              onclick={() =>
                navigate({ reaction: data.reaction ?? undefined, before: data.prev ?? undefined })}
            >
              <IconChevronLeft size={13} /> Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={data.next === null}
              onclick={() =>
                navigate({ reaction: data.reaction ?? undefined, after: data.next ?? undefined })}
            >
              Older <IconChevronRight size={13} />
            </Button>
          </div>
        </div>
      {/if}
    {:catch err}
      <div class="flex h-32 flex-col items-center justify-center gap-2 text-center text-sm">
        <p class="text-red-300">
          Couldn't load who reacted. {err instanceof Error ? err.message : ''}
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
