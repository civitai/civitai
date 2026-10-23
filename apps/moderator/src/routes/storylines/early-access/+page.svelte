<script lang="ts">
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const lastPage = $derived(Math.max(1, Math.ceil(data.total / data.limit)));
</script>

<header class="page-header">
  <h1>Storyline Early Access</h1>
</header>

<p class="mb-3 text-sm text-dark-2">
  Readers who asked for the story-creation tool from the end of a chapter. {num(data.total)}
  {data.total === 1 ? 'sign-up' : 'sign-ups'}, newest first.
</p>

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">Nobody has signed up yet.</p>
{:else}
  <ul class="space-y-2" data-testid="early-access-signups">
    {#each data.items as row (row.userId)}
      <li
        class="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-dark-4 bg-dark-6 px-4 py-3"
      >
        <a href={userLookupUrl(row.userId)} class="font-medium {LINK_CLASS}">
          {row.username ?? `User ${row.userId}`}
        </a>
        <code class="text-xs text-dark-2">#{row.userId}</code>
        <span class="text-xs text-dark-2">{dateTime(row.createdAt)}</span>
        {#if row.storylineId}
          <span class="text-xs text-dark-2">
            from
            <a
              href={`${data.civitaiUrl}/storylines/${row.storylineId}`}
              target="_blank"
              rel="noreferrer"
              class={LINK_CLASS}
            >
              {row.storylineTitle ?? `storyline #${row.storylineId}`}
            </a>
          </span>
        {/if}
      </li>
    {/each}
  </ul>

  {#if lastPage > 1}
    <nav class="mt-4 flex items-center gap-4 text-sm">
      {#if data.page > 1}
        <a href={`?page=${data.page - 1}`} class={LINK_CLASS}>Newer</a>
      {/if}
      <span class="text-dark-2">Page {data.page} of {lastPage}</span>
      {#if data.page < lastPage}
        <a href={`?page=${data.page + 1}`} class={LINK_CLASS}>Older</a>
      {/if}
    </nav>
  {/if}
{/if}
