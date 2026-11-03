<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import NumberedPager from '$lib/components/NumberedPager.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { keepLast } from '$lib/keep-last.svelte';
  import {
    PAGE_SIZE,
    SHADOW_SEXUAL_PROMPT_PATH,
    levelLabel,
    type WouldRaiseRow,
  } from '$lib/shadow-sexual-prompt';
  import { urlWith } from '$lib/url';

  let { currentPage, civitaiUrl }: { currentPage: number; civitaiUrl: string } = $props();

  // keepLast, not a derived promise: paging refines a list the moderator is reading, and the
  // pending branch would replace it (and the pager under their cursor) on every click.
  const list = keepLast(() => {
    if (!browser) return null;
    return fetch(`${SHADOW_SEXUAL_PROMPT_PATH}/list${page.url.search}`).then(
      (r): Promise<{ rows: WouldRaiseRow[]; total: number }> => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }
    );
  });
</script>

{#if list.failed}
  <ErrorAlert
    class="mb-3"
    message={list.value
      ? 'Could not load this page; showing the last one.'
      : 'Could not load the would-raise list.'}
  />
{/if}

{#if list.value}
  {@const { rows, total } = list.value}
  <div class={list.loading ? 'opacity-60' : ''}>
    {#if rows.length === 0}
      <p class="text-sm text-dark-2">
        {total ? 'No rows on this page.' : 'No image in this window would be raised at these levels.'}
      </p>
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Image</TableHead>
            <TableHead>Level at scan → would be</TableHead>
            <TableHead class="text-right">Score</TableHead>
            <TableHead>Field</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Scanned</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each rows as row (row.imageId)}
            <TableRow>
              <TableCell>
                <a
                  href={`${civitaiUrl}/images/${row.imageId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-mono {LINK_CLASS}">{row.imageId}</a
                >
              </TableCell>
              <TableCell class="text-dark-0">
                {levelLabel(row.currentNsfwLevel)} → {levelLabel(row.wouldNsfwLevel)}
              </TableCell>
              <TableCell class="text-right tabular-nums">{row.score.toFixed(3)}</TableCell>
              <TableCell class="text-dark-2">{row.field || '—'}</TableCell>
              <TableCell class="text-dark-2">{row.onSite ? 'On-site' : 'Off-site'}</TableCell>
              <TableCell class="text-xs text-dark-2">{dateTime(row.scannedAt)}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}

    <NumberedPager
      page={currentPage}
      {total}
      perPage={PAGE_SIZE}
      label="images"
      onPageChange={(p) => goto(urlWith(page.url, { page: p }), { noScroll: true, keepFocus: true })}
    />
  </div>
{:else if !list.failed}
  <p class="text-sm text-dark-2">Loading images…</p>
{/if}
