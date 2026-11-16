<script lang="ts">
  import { enhance } from '$app/forms';
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
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { GENERATOR_EVIDENCE_HOLD_REASON } from '@civitai/db-queries/evidence-hold';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { csamReportUrl } from '$lib/entity-url';
  import { dateTime, LINK_CLASS, plural } from '$lib/format';
  import { urlWith } from '$lib/url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // The grant wrapper widens ActionData to `{}`; these are the shapes the two actions return.
  type HoldResult = { scope?: 'place' | 'release' | 'denied'; error?: string; holdId?: number; created?: boolean };
  const result = $derived(form as HoldResult | null);
  const formError = $derived(result?.error ?? null);

  const DAY_MS = 24 * 60 * 60 * 1000;

  const daysLeft = (end: Date) =>
    Math.max(0, Math.ceil((end.getTime() - data.asOf) / DAY_MS));

  // Mirrors what releaseEvidenceHold accepts, so no row offers a release the server refuses.
  const releasable = (hold: { role: string; reason: string; extendedUntil: Date | null }) =>
    hold.role === 'manual' &&
    hold.reason !== GENERATOR_EVIDENCE_HOLD_REASON &&
    (!hold.extendedUntil || hold.extendedUntil.getTime() <= data.asOf);

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
    Extensions are recorded outside this page.
  </p>

  <details class="rounded border border-dark-4 p-3">
    <summary class="cursor-pointer text-sm font-medium text-white">Place a manual hold</summary>
    <form method="POST" action="?/place" use:enhance class="mt-3 flex flex-wrap items-end gap-3 text-sm">
      <label class="flex flex-col gap-1">
        <span class="text-dark-2">User id</span>
        <Input name="userId" inputmode="numeric" required class="w-32" />
      </label>
      <label class="flex min-w-64 flex-1 flex-col gap-1">
        <span class="text-dark-2">Reason</span>
        <Input name="reason" required maxlength={500} />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-dark-2">Held through (optional)</span>
        <Input name="releaseAt" type="date" class="w-40" />
      </label>
      <Button type="submit" size="sm">Place hold</Button>
    </form>
    {#if result?.scope === 'place' || (result?.scope === 'denied' && !result.holdId)}
      <p class="m-0 mt-2 text-sm {formError ? 'text-rose-400' : 'text-dark-2'}">
        {#if formError}
          {formError}
        {:else if result?.holdId}
          {result.created
            ? `Hold #${result.holdId} placed.`
            : `Already held for that reason: hold #${result.holdId}.`}
        {/if}
      </p>
    {/if}
  </details>
  {#if result?.scope === 'release'}
    <p class="m-0 text-sm {formError ? 'text-rose-400' : 'text-dark-2'}">
      {formError ?? `Hold #${result.holdId} released.`}
    </p>
  {/if}
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
                    <span class="text-dark-2">{hold.reason}</span>
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
                    {#if releasable(hold)}
                    <form method="POST" action="?/release" use:enhance class="flex items-center gap-1">
                      <input type="hidden" name="holdId" value={hold.id} />
                      <Input
                        name="releaseReason"
                        required
                        maxlength={500}
                        placeholder="Reason to release"
                        aria-label="Reason to release hold {hold.id}"
                        class="h-7 w-44 text-xs"
                      />
                      <Button type="submit" size="sm" variant="outline">Release</Button>
                    </form>
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
