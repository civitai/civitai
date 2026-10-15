<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { shortAge } from '$lib/format';
  import { urlWith } from '$lib/url';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';
  import AppealTags from './AppealTags.svelte';

  let {
    rows,
    selectedId,
    verdicts,
    errors,
    onselect,
  }: {
    rows: MinorFlagAppealRow[];
    selectedId: number | null;
    verdicts: ReadonlyMap<number, string>;
    errors: ReadonlyMap<number, string>;
    onselect: (appealId: number) => void;
  } = $props();

  const onclick = (e: MouseEvent, appealId: number) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onselect(appealId);
  };
</script>

<ul class="m-0 list-none divide-y divide-dark-4 p-0">
  {#each rows as row (row.appealId)}
    {@const verdict = verdicts.get(row.appealId)}
    {@const error = errors.get(row.appealId)}
    {@const cover = row.coverImages[0]}
    <li id="appeal-{row.appealId}">
      <a
        href={urlWith(page.url, { appeal: row.appealId })}
        onclick={(e) => onclick(e, row.appealId)}
        aria-current={row.appealId === selectedId ? 'true' : undefined}
        class={cn(
          'flex gap-3 border-l-2 px-3 py-2.5 transition-colors hover:bg-dark-5',
          row.appealId === selectedId ? 'border-blue-500 bg-dark-5' : 'border-transparent',
          verdict && 'opacity-50'
        )}
      >
        <div class="size-11 shrink-0 overflow-hidden rounded-md border border-dark-4 bg-dark-7">
          {#if cover}
            <EdgeMedia
              src={cover.url}
              type="image"
              width={96}
              class="size-full object-cover"
            />
          {/if}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-2">
            <span class="truncate text-sm font-medium text-white">{row.modelName}</span>
            <span class="shrink-0 text-xs text-dark-2 tabular-nums">
              waiting {shortAge(row.appealCreatedAt)}
            </span>
          </div>
          {#if error}
            <p class="m-0 mt-1 text-sm text-red-300">Failed: {error}</p>
          {/if}
          {#if verdict}
            <p class="m-0 mt-1 text-sm text-dark-0">{verdict}</p>
          {:else}
            <div class="mt-1 flex flex-wrap items-center gap-1">
              <AppealTags {row} />
            </div>
          {/if}
        </div>
      </a>
    </li>
  {/each}
</ul>
