<script lang="ts">
  import { LINK_CLASS } from '$lib/format';
  import BoxFlow from './BoxFlow.svelte';
  import type { FlowStep } from './steps';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let step = $state<FlowStep>('basics');
  let dirty = $state(false);
</script>

<header class="page-header">
  <h1>#{data.box.id} {data.draft.name}</h1>
  <span class="flex gap-3 text-sm">
    <a class={LINK_CLASS} href="/items/boxes/{data.box.id}/openings">Openings</a>
    <a class={LINK_CLASS} href="/items/boxes/{data.box.id}">Old editor</a>
  </span>
</header>

<!-- Remounts on every write to the box (each stamps updatedAt), so the working copy restarts from the
     rows the server wrote, with their new ids. The step lives out here so it survives that. -->
{#key `${data.box.version}:${data.box.updatedAt}`}
  <BoxFlow
    box={data.box}
    initial={data.draft}
    initialRewards={data.rewards}
    events={data.events}
    snapshots={data.snapshots}
    listings={data.listings}
    civitaiUrl={data.civitaiUrl}
    bind:step
    bind:dirty
    onpublished={() => (step = 'sell')}
  />
{/key}
