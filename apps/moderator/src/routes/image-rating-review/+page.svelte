<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { SvelteMap } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { browsingLevels, NsfwLevel, getBrowsingLevelLabel } from '@civitai/shared';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Severity tint per level (green → red); used on the chip label when the chip isn't the set one.
  const LEVEL_COLOR: Record<number, string> = {
    [NsfwLevel.PG]: 'text-emerald-400',
    [NsfwLevel.PG13]: 'text-lime-400',
    [NsfwLevel.R]: 'text-amber-400',
    [NsfwLevel.X]: 'text-orange-400',
    [NsfwLevel.XXX]: 'text-red-400',
    [NsfwLevel.Blocked]: 'text-rose-400',
  };
  const limitOptions = [10, 25, 50, 100];

  const acted = new SvelteMap<number, number>(); // imageId → level the mod set (optimistic; dims the card)

  // reset optimistic state when a new page/filter loads (commits use invalidateAll:false, so they persist)
  $effect(() => {
    data.items;
    acted.clear();
  });

  // Highest-severity level anyone requested (owner or community), from the per-level request weights.
  function highestRequested(votes: Record<string, number>): number | null {
    let hi: number | null = null;
    for (const lv of browsingLevels) if ((votes[lv] ?? 0) > 0) hi = lv;
    return hi;
  }

  // One click commits the level. Optimistic — the card dims but stays editable, so a re-click re-commits.
  const submit: SubmitFunction = ({ formData }) => {
    acted.set(Number(formData.get('id')), Number(formData.get('nsfwLevel')));
    return async ({ update }) => update({ invalidateAll: false });
  };
</script>

<header class="page-header flex flex-wrap items-center justify-between gap-2">
  <h1>Image Rating Review</h1>
  <select
    class="h-8 rounded-md border bg-background px-2 text-sm"
    value={data.limit}
    onchange={(e) => goto(`?limit=${e.currentTarget.value}`)}
  >
    {#each limitOptions as n (n)}<option value={n}>{n} items</option>{/each}
  </select>
</header>

<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
  <span class="inline-flex items-center gap-1.5"><span class="inline-block h-3 w-5 rounded bg-teal-600"></span> currently set</span>
  <span class="inline-flex items-center gap-1.5"><span class="inline-block h-3 w-5 rounded ring-2 ring-inset ring-violet-400"></span> highest requested</span>
  <span class="text-muted-foreground/70">· one click sets the level · click again to change</span>
</div>

{#if data.items.length === 0}
  <div class="placeholder">No images awaiting rating review.</div>
{:else}
  <div class="grid gap-5" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))">
    {#each data.items as item (item.id)}
      {@const setLevel = acted.get(item.id) ?? item.nsfwLevel}
      {@const reqLevel = highestRequested(item.votes)}
      {@const isActioned = acted.has(item.id)}
      {@const isBlocked = acted.get(item.id) === NsfwLevel.Blocked}
      <Card class="gap-0 overflow-hidden p-0 transition-opacity {isActioned ? 'opacity-60' : ''}">
        <div class="flex aspect-[4/5] items-center justify-center overflow-hidden bg-muted">
          <a
            href={`${data.civitaiUrl}/images/${item.id}`}
            target="_blank"
            rel="noreferrer"
            class="flex h-full w-full items-center justify-center"
          >
            <EdgeMedia src={item.url} type={item.type} width={450} class="max-h-full max-w-full object-contain" />
          </a>
        </div>
        <CardContent class="flex flex-col gap-2.5 p-2.5">
          <form method="POST" action="?/setLevel" use:enhance={submit}>
            <input type="hidden" name="id" value={item.id} />
            <div class="grid grid-cols-5 gap-1.5">
              {#each browsingLevels as lv (lv)}
                {@const isSet = setLevel === lv}
                {@const isReq = reqLevel === lv}
                <div class="flex flex-col gap-1">
                  <div class="flex min-h-[1.1rem] flex-col items-center text-[0.6rem] font-bold uppercase leading-tight tracking-wide">
                    {#if isSet}<span class="text-teal-500">set</span>{/if}
                    {#if isReq}<span class="text-violet-400">req</span>{/if}
                  </div>
                  <button
                    type="submit"
                    name="nsfwLevel"
                    value={lv}
                    class="rounded-md border py-1.5 text-xs font-semibold transition {isSet
                      ? 'border-teal-600 bg-teal-600 text-white'
                      : `border-border bg-muted hover:border-muted-foreground ${LEVEL_COLOR[lv]}`} {isReq
                      ? 'ring-2 ring-inset ring-violet-400'
                      : ''}"
                  >
                    {getBrowsingLevelLabel(lv)}
                  </button>
                </div>
              {/each}
            </div>

            <div class="mt-2 flex items-center gap-2">
              <button
                type="submit"
                name="nsfwLevel"
                value={NsfwLevel.Blocked}
                class="rounded-md border px-3 py-1.5 text-xs font-semibold transition {isBlocked
                  ? 'border-rose-500 bg-rose-500 text-white'
                  : 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10'}"
              >
                Block
              </button>
              {#if isActioned}
                <span class="ml-auto text-xs font-semibold text-teal-500">
                  ✓ {isBlocked ? 'Blocked' : `Set to ${getBrowsingLevelLabel(setLevel)}`}
                </span>
              {/if}
            </div>
          </form>
        </CardContent>
      </Card>
    {/each}
  </div>

  <div class="mt-6 flex justify-center">
    {#if data.nextCursor}
      <Button size="lg" onclick={() => goto(`?cursor=${data.nextCursor}&limit=${data.limit}`)}>Next</Button>
    {:else}
      <span class="text-sm text-muted-foreground">End of queue.</span>
    {/if}
  </div>
{/if}
