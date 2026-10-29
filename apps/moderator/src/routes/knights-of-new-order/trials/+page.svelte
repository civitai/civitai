<script lang="ts">
  import { enhance } from '$app/forms';
  import { browsingLevels, getBrowsingLevelLabel } from '@civitai/shared';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import CoreItemCard from './CoreItemCard.svelte';
  import SpotCheckCard from './SpotCheckCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const tabs = $derived([
    { tab: 'core', label: `Core set (${data.counts.core})` },
    { tab: 'fresh', label: `Fresh (${data.counts.fresh})` },
    { tab: 'spot-check', label: `Spot-check (${data.counts.spotCheck})` },
  ]);

  const add = new FormState({ reload: true, onSuccess: () => toast.success('Added to the core set') });
  let level = $state<number | null>(null);
</script>

<header class="page-header">
  <h1>Knights of New Order Trials</h1>
  <p>
    Images Acolytes are tested on. Core images teach: they are always in a run and show their
    explanation after the answer. Fresh images come from recent moderator rulings and are what scores
    a run. Promote a good fresh image to the core set, retire one that misleads, and rate pending
    images blind when the spot-check is on.
  </p>
</header>

<nav class="mb-4 flex gap-2" aria-label="Trials view">
  {#each tabs as t (t.tab)}
    <a
      href="?tab={t.tab}"
      class="rounded-md border border-dark-4 px-3 py-1 text-sm {data.tab === t.tab
        ? 'bg-dark-5 text-white'
        : 'text-dark-2 hover:text-white'}">{t.label}</a
    >
  {/each}
</nav>

{#if data.tab === 'core'}
  <section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-2 font-medium">Add a core image</h2>
    {#if add.error}<p class="mb-2 text-sm text-red-300">{add.error}</p>{/if}
    <form method="POST" action="?/add" use:enhance={add.enhance} class="flex flex-col gap-2">
      <input type="hidden" name="level" value={level ?? ''} />
      <label class="flex items-center gap-2 text-sm text-dark-2">
        Image id
        <input name="imageId" inputmode="numeric" required class="w-40 rounded-md border border-dark-4 bg-dark-7 px-2 py-1 text-white" />
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm text-dark-2">Answer</span>
        {#each browsingLevels as option (option)}
          <Button type="button" size="sm" variant={option === level ? 'secondary' : 'outline'} onclick={() => (level = option)}
            >{getBrowsingLevelLabel(option)}</Button
          >
        {/each}
      </div>
      <Textarea name="explanation" rows={2} required placeholder="Why this rating, shown to Acolytes after they answer" />
      <div><Button type="submit" size="sm" disabled={add.submitting || level === null}>Add</Button></div>
    </form>
  </section>
{/if}

{#if data.tab === 'spot-check'}
  <p class="mb-3 text-sm text-dark-2">
    Rate each image without seeing the rating it was harvested with. A match lets it into Trials; a
    different rating keeps it out.
  </p>
  {#if data.spotCheck.length === 0}
    <p class="text-sm text-dark-2">Nothing is waiting for a spot-check.</p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each data.spotCheck as item (item.id)}
        <SpotCheckCard {item} />
      {/each}
    </div>
  {/if}
{:else if data.items.length === 0}
  <p class="text-sm text-dark-2">Nothing here.</p>
{:else}
  {#if data.tab === 'fresh'}
    <p class="mb-3 text-sm text-dark-2">
      Flagged images are those Acolytes miss at a high rate once enough have answered (at least
      {data.flagRule.minAnswers} answers, {Math.round(data.flagRule.failureRate * 100)}% missed). Look
      at them first: the rating may be wrong. Fresh images age out on their own.
    </p>
  {/if}
  <div class="flex flex-col gap-3">
    {#each data.items as item (item.id)}
      <CoreItemCard {item} mode={data.tab === 'fresh' ? 'fresh' : 'core'} />
    {/each}
  </div>
  {#if data.items.length >= data.limit}
    <p class="mt-3 text-xs text-dark-2">Showing the first {data.limit}.</p>
  {/if}
{/if}
