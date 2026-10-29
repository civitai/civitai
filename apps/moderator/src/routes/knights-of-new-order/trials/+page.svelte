<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import CoreItemCard from './CoreItemCard.svelte';
  import LevelPicker from './LevelPicker.svelte';
  import SpotCheckCard from './SpotCheckCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const tabs = $derived([
    { value: 'core', label: `Core set (${data.counts.core})`, href: '?tab=core' },
    { value: 'fresh', label: `Fresh (${data.counts.fresh})`, href: '?tab=fresh' },
    { value: 'spot-check', label: `Spot-check (${data.counts.spotCheck})`, href: '?tab=spot-check' },
  ]);
  const empty = {
    core: 'The core set is empty. Add an image above, or promote one from the Fresh tab.',
    fresh: 'No fresh images are in Trials right now. They arrive with the next harvest of moderator rulings.',
    'spot-check': 'Nothing is waiting for a spot-check.',
  } as const;

  let level = $state<number | null>(null);
  const add = new FormState({
    onSuccess: () => {
      level = null;
      void invalidateAll();
      toast.success('Added to the core set');
    },
  });
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

<LinkTabs class="mb-4" items={tabs} active={data.tab} />

{#if data.tab === 'core'}
  <section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-2 font-medium">Add a core image</h2>
    {#if add.error}<ErrorAlert class="mb-2" message={add.error} />{/if}
    <form method="POST" action="?/add" use:enhance={add.enhance} class="flex flex-col gap-2">
      <label class="flex items-center gap-2 text-sm text-dark-2">
        Image id
        <Input name="imageId" inputmode="numeric" required class="w-40" />
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm text-dark-2">Answer</span>
        <LevelPicker bind:value={level} />
      </div>
      <Textarea
        name="explanation"
        rows={2}
        required
        placeholder="Why this rating, shown to Acolytes after they answer"
      />
      <div>
        <Button type="submit" size="sm" disabled={add.submitting || level === null}>Add</Button>
      </div>
    </form>
  </section>
{/if}

{#if data.tab === 'spot-check'}
  <p class="mb-3 text-sm text-dark-2">
    Rate each image without seeing the rating it was harvested with. A match lets it into Trials; a
    different rating keeps it out.
  </p>
  {#if data.spotCheck.length === 0}
    <p class="text-sm text-dark-2">{empty['spot-check']}</p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each data.spotCheck as item (item.id)}
        <SpotCheckCard {item} />
      {/each}
    </div>
  {/if}
{:else if data.items.length === 0}
  <p class="text-sm text-dark-2">{empty[data.tab]}</p>
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
