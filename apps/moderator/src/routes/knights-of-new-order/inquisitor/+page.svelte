<script lang="ts">
  import InquisitorCard from './InquisitorCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Knights of New Order Inquisitor queue</h1>
  <p>
    Images the Knights could not settle: split votes that ran out of ranks, large down-ratings, Blocked
    suggestions and write-backs that failed. Your rating is set on the image as a moderator ruling and
    every pending vote is graded against it.
  </p>
</header>

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">No images are waiting for an Inquisitor ruling.</p>
{:else}
  <div class="flex flex-col gap-3">
    {#each data.items as item (item.id)}
      <InquisitorCard {item} />
    {/each}
  </div>
  {#if data.items.length >= data.limit}
    <p class="mt-3 text-xs text-dark-2">Showing the first {data.limit}, by priority and age.</p>
  {/if}
{/if}
