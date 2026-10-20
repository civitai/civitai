<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { csamReportUrl } from '$lib/entity-url';
  import { dateTime, LINK_CLASS, plural } from '$lib/format';
  import { urlWith } from '$lib/url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const DAY_MS = 24 * 60 * 60 * 1000;

  const daysLeft = (end: Date) =>
    Math.max(0, Math.ceil((end.getTime() - data.asOf) / DAY_MS));

  // A row's own end. One that has passed is shown, not hidden: its owner is still held by another row.
  const rowEnd = (hold: { releaseAt: Date | null; extendedUntil: Date | null }) => {
    if (!hold.releaseAt) return null;
    return hold.extendedUntil && hold.extendedUntil > hold.releaseAt
      ? hold.extendedUntil
      : hold.releaseAt;
  };

  const allHeldHref = $derived(urlWith(page.url, { ending: '0', page: null }));

  const filters = $derived([
    {
      value: '1',
      label: `Ending within ${data.windowDays} days (${data.endingCount})`,
      href: urlWith(page.url, { ending: '1', page: null }),
    },
    { value: '0', label: 'All held', href: allHeldHref },
  ]);

  const pageHref = (n: number) => urlWith(page.url, { page: n > 1 ? n : null });
</script>

<div class="flex flex-col gap-3 px-6 pb-4">
  <h1 class="m-0 text-xl font-semibold text-white">Evidence holds</h1>
  <p class="m-0 text-sm text-dark-2">
    {#if data.endingCount > 0 && data.earliest}
      {plural(data.endingCount, 'owner')} ending within {data.windowDays} days, the earliest
      {dateTime(data.earliest)}.
    {:else}
      No hold ends within {data.windowDays} days.
    {/if}
    Read-only: holds are extended and released outside this page.
  </p>
  <nav aria-label="Filter" data-sveltekit-noscroll>
    <LinkTabs items={filters} active={data.endingOnly ? '1' : '0'} />
  </nav>

  {#if data.items.length === 0}
    <p class="m-0 text-sm text-dark-2">
      {#if data.page > 1}
        Nothing on this page.
        <a href={pageHref(1)} class={LINK_CLASS}>Back to the first page</a>
      {:else if data.endingOnly}
        <a href={allHeldHref} class={LINK_CLASS}>Show everyone held</a>
      {:else}
        Nobody is held.
      {/if}
    </p>
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Owner</TableHead>
          <TableHead>Held until</TableHead>
          <TableHead>Holds</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.items as owner (owner.userId)}
          <TableRow>
            <TableCell class="align-top">
              <a
                href={csamReportUrl(data.civitaiUrl, owner.userId)}
                class={LINK_CLASS}
                target="_blank"
                rel="noreferrer"
              >
                {owner.username ?? `user #${owner.userId}`}
              </a>
            </TableCell>
            <TableCell class="align-top">
              {#if owner.heldUntil}
                <div>{dateTime(owner.heldUntil)}</div>
                <div class="text-xs text-dark-2">{plural(daysLeft(owner.heldUntil), 'day')} left</div>
              {:else}
                <span class="text-dark-2">No end date</span>
              {/if}
            </TableCell>
            <TableCell class="align-top">
              <ul class="m-0 flex list-none flex-col gap-1 p-0 text-xs">
                {#each owner.holds as hold (hold.id)}
                  {@const end = rowEnd(hold)}
                  <li class="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{hold.role}</Badge>
                    {#if hold.csamReportId}
                      <code class="text-dark-2">report #{hold.csamReportId}</code>
                    {/if}
                    <span>
                      {#if !end}
                        no end date
                      {:else if end.getTime() <= data.asOf}
                        ended {dateTime(end)}
                      {:else}
                        ends {dateTime(end)}
                      {/if}
                    </span>
                    {#if hold.extendedUntil}
                      <span class="text-dark-2">
                        extended to {dateTime(hold.extendedUntil)} from {dateTime(hold.releaseAt)}
                        · requested by {hold.extensionRequestedBy ?? '—'} · ref
                        {hold.extensionReference ?? '—'}
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
    {#if data.page > 1 || data.hasMore}
      <div class="flex items-center gap-3 text-sm">
        {#if data.page > 1}
          <a href={pageHref(data.page - 1)} class={LINK_CLASS}>← Previous</a>
        {/if}
        <span class="text-dark-2">Page {data.page}</span>
        {#if data.hasMore}
          <a href={pageHref(data.page + 1)} class={LINK_CLASS}>Next →</a>
        {/if}
      </div>
    {/if}
  {/if}
</div>
