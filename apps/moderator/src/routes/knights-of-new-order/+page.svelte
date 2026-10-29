<script lang="ts">
  import LinkReviewCard from './LinkReviewCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const tabs = [
    { status: 'Pending', label: 'To review' },
    { status: 'Blocked', label: 'Payouts held' },
    { status: 'Cleared', label: 'Cleared' },
  ] as const;
</script>

<header class="page-header">
  <h1>Knights of New Order review</h1>
  <p>
    Groups of Knights of New Order accounts that look like one operator. Block holds the group's Knights payouts,
    which stay pending; Clear releases them and removes the hold. Holds placed automatically are
    listed under Payouts held and can be cleared on appeal.
  </p>
</header>

<nav class="mb-4 flex gap-2" aria-label="Review status">
  {#each tabs as tab (tab.status)}
    <a
      href="?status={tab.status}"
      class="rounded-md border border-dark-4 px-3 py-1 text-sm {data.status === tab.status
        ? 'bg-dark-5 text-white'
        : 'text-dark-2 hover:text-white'}">{tab.label}</a
    >
  {/each}
</nav>

{#if data.reviews.length === 0}
  <p class="text-sm text-dark-2">Nothing here.</p>
{:else}
  <div class="flex flex-col gap-3">
    {#each data.reviews as review (review.id)}
      <LinkReviewCard {review} />
    {/each}
  </div>
  {#if data.reviews.length >= data.limit}
    <p class="mt-3 text-xs text-dark-2">Showing the first {data.limit}, largest Buzz first.</p>
  {/if}
{/if}
