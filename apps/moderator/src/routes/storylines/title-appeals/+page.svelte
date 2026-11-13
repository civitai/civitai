<script lang="ts">
  import { enhance } from '$app/forms';
  import { SvelteMap } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const acted = new SvelteMap<number, string>();
  $effect(() => {
    data.items;
    acted.clear();
  });

  // A refused verdict must undo its mark, or a moderator believes they ruled on an appeal that
  // is still open.
  const submit = (storylineId: number, verdict: string) =>
    optimisticEnhancer(
      () => {
        acted.set(storylineId, verdict);
        return () => acted.delete(storylineId);
      },
      { reload: true }
    );
</script>

<header class="page-header">
  <h1>Storyline Title Appeals</h1>
</header>

{#if form && 'error' in form && form.error}
  <ErrorAlert class="mb-4" message={form.error} />
{/if}

{#if data.hasMore}
  <p class="mb-2 text-xs text-dark-2">Showing the oldest {data.limit} open appeals.</p>
{/if}

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">No open appeals against a title-scan takedown.</p>
{:else}
  <ul class="space-y-2">
    {#each data.items as row (row.storylineId)}
      {@const verdict = acted.get(row.storylineId)}
      <li
        class={cn(
          'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
          verdict && 'opacity-50'
        )}
      >
        <div class="flex flex-wrap items-baseline gap-x-2">
          <a
            href={`${data.civitaiUrl}/storylines/${row.storylineId}`}
            target="_blank"
            rel="noreferrer"
            class="font-medium {LINK_CLASS}"
          >
            {row.title}
          </a>
          <code class="text-xs text-dark-2">#{row.storylineId}</code>
          {#if !row.tosViolationByScan}
            <Badge variant="outline">no longer taken down by the scan</Badge>
          {/if}
          {#if row.tosViolationByModerator}
            <Badge variant="destructive">taken down by a moderator</Badge>
          {/if}
          {#if row.username}
            <a href={userLookupUrl(row.userId)} class="text-xs {LINK_CLASS}">{row.username}</a>
          {/if}
        </div>

        <p class="mt-2 rounded-md bg-dark-7 p-2 text-sm text-dark-0">{row.appealMessage}</p>
        <p class="mt-1 text-xs text-dark-2">appealed {dateTime(row.appealCreatedAt)}</p>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          {#if verdict}
            <span class="text-sm text-dark-2">{verdict}</span>
          {:else}
            <form
              method="POST"
              action="?/deny"
              use:enhance={submit(row.storylineId, 'Appeal denied')}
            >
              <input type="hidden" name="storylineId" value={row.storylineId} />
              <input type="hidden" name="reviewedTitle" value={row.title} />
              <Button
                type="submit"
                size="xs"
                disabled={!row.tosViolationByScan && !row.tosViolationByModerator}
              >
                Keep it down
              </Button>
            </form>
            <form
              method="POST"
              action="?/grant"
              use:enhance={submit(row.storylineId, 'Appeal granted')}
            >
              <input type="hidden" name="storylineId" value={row.storylineId} />
              <input type="hidden" name="reviewedTitle" value={row.title} />
              <Button type="submit" size="xs" variant="destructive" disabled={row.tosViolationByModerator}>
                Grant and lift
              </Button>
            </form>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
