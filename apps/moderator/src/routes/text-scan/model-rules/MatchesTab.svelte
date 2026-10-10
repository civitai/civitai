<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { urlWith } from '$lib/url';
  import type { PageData } from './$types';

  let {
    matches,
    query,
    civitaiUrl,
    url,
  }: {
    matches: NonNullable<PageData['matches']>;
    query: PageData['query'];
    civitaiUrl: string;
    url: URL;
  } = $props();

  const MODES = [
    { value: 'all', label: 'All' },
    { value: 'shadow', label: 'Shadow' },
    { value: 'active', label: 'Active' },
  ] as const;

  const modeItems = $derived(
    MODES.map(({ value, label }) => ({
      value,
      label,
      href: urlWith(url, { mode: value === 'all' ? null : value, cursor: null }),
    }))
  );
  const filtered = $derived(query.mode !== 'all' || query.rule !== undefined);

  const nextHref = $derived(
    matches.nextCursor === undefined ? null : urlWith(url, { cursor: matches.nextCursor })
  );
</script>

<div class="mb-3 flex flex-wrap items-end gap-3">
  <LinkTabs items={modeItems} active={query.mode} />

  <form method="GET" class="flex items-end gap-2">
    <input type="hidden" name="tab" value="matches" />
    {#if query.mode !== 'all'}<input type="hidden" name="mode" value={query.mode} />{/if}
    <Input
      name="rule"
      type="number"
      min="1"
      value={query.rule ?? ''}
      placeholder="Rule id"
      class="w-32"
      aria-label="Filter by rule id"
    />
    <Button type="submit" variant="outline" size="sm">Filter</Button>
    {#if query.rule !== undefined}
      <Button href={urlWith(url, { rule: null, cursor: null })} variant="ghost" size="sm">
        Clear
      </Button>
    {/if}
  </form>
</div>

{#if matches.items.length === 0}
  <p class="text-sm text-dark-2">{filtered ? 'No matches for these filters.' : 'No matches yet.'}</p>
{:else}
  <div class="rounded-xl border border-dark-4 bg-dark-6">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>Matched rules</TableHead>
          <TableHead>Scanned</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each matches.items as row (row.id)}
          <TableRow>
            <TableCell class="max-w-64 whitespace-normal break-words align-top">
              <a
                href="{civitaiUrl}/models/{row.modelId}"
                class={LINK_CLASS}
                target="_blank"
                rel="noreferrer"
              >
                {row.modelName ?? `Model ${row.modelId}`}
              </a>
              <div class="text-xs text-dark-2">#{row.modelId}</div>
            </TableCell>
            <TableCell class="align-top">
              <Badge variant={row.mode === 'active' ? 'default' : 'secondary'}>{row.mode}</Badge>
            </TableCell>
            <TableCell class="whitespace-normal align-top">
              <ul class="flex flex-col gap-2">
                {#each row.matches as match (match.ruleId)}
                  <li>
                    <span class="font-medium text-white">{match.subject ?? 'Unknown rule'}</span>
                    <a href={urlWith(url, { rule: match.ruleId, cursor: null })} class="ml-1 text-xs {LINK_CLASS}">
                      rule {match.ruleId}
                    </a>
                    {#if match.reason}
                      <p class="mt-0.5 break-words text-sm text-dark-2">{match.reason}</p>
                    {/if}
                  </li>
                {/each}
              </ul>
            </TableCell>
            <TableCell class="whitespace-normal align-top text-xs text-dark-2">
              {dateTime(row.scannedAt)}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
  <CursorPager href={nextHref} />
{/if}
