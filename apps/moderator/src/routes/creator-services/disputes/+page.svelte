<script lang="ts">
  import { page } from '$app/state';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import { urlWith } from '$lib/url';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import DisputeCard from './DisputeCard.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // The action answers for one deal; each card renders only its own answer.
  const outcomeFor = (id: number) => (form && 'dealId' in form && form.dealId === id ? form : null);
</script>

<header class="page-header">
  <h1>Creator Services Disputes</h1>
</header>

{#if data.error}
  <ErrorAlert class="mb-4" message={data.error} />
{/if}

{#if form && 'error' in form && form.error && !('dealId' in form)}
  <ErrorAlert class="mb-4" message={form.error} />
{/if}

{#if form && 'success' in form && form.success}
  <p class="mb-4 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-200">
    Deal #{form.dealId}: {form.heldForReview
      ? `sent back to review: ${form.heldForReview}`
      : form.alreadyResolved
        ? `already resolved as ${form.resolution} (no Buzz moved by this ruling)`
        : `resolved as ${form.resolution}`}.
  </p>
{/if}

{#if !data.error}
  <p class="mb-2 text-xs text-dark-2">Oldest dispute first.</p>
{/if}

{#if data.items.length === 0 && !data.error}
  <p class="text-sm text-dark-2">No deals are waiting on a ruling.</p>
{:else}
  <ul class="space-y-2">
    {#each data.items as row (row.id)}
      <DisputeCard
        {row}
        canResolve={!!data.grants['creatorServices.resolveDispute']}
        outcome={outcomeFor(row.id)}
      />
    {/each}
  </ul>
{/if}

<CursorPager href={data.nextCursor ? urlWith(page.url, { cursor: data.nextCursor }) : null} />
