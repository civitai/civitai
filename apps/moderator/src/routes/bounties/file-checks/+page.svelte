<script lang="ts">
  import { enhance } from '$app/forms';
  import { SvelteMap } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { bountyEntryUrl, userLookupUrl } from '$lib/entity-url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const cleared = new SvelteMap<number, true>();
  const reblocked = new SvelteMap<number, true>();
  // Held here, not in the form: the row dims on submit and comes back on a refusal.
  const reasons = new SvelteMap<number, string>();
  const reblockReasons = new SvelteMap<number, string>();
  $effect(() => {
    void data.blocked;
    cleared.clear();
  });
  $effect(() => {
    void data.cleared;
    reblocked.clear();
  });

  const refusal = $derived.by(() => {
    if (!form || !('error' in form) || !form.error) return null;
    const fileId = 'fileId' in form ? form.fileId : undefined;
    return fileId ? `File #${fileId}: ${form.error}` : form.error;
  });

  const submit = (done: SvelteMap<number, true>, fileId: number) =>
    optimisticEnhancer(
      () => {
        done.set(fileId, true);
        return () => done.delete(fileId);
      },
      { reload: true }
    );

  // The expiry job settles a bounty two days after it ends; one with an unchecked file waits.
  const AWARD_DELAY_MS = 2 * 24 * 60 * 60 * 1000;
  const awardWaiting = (expiresAt: Date) =>
    new Date(expiresAt).getTime() + AWARD_DELAY_MS <= Date.now();
</script>

{#snippet entry(row: {
  fileId: number;
  fileName: string;
  entryId: number;
  entrantId: number | null;
  entrant: string | null;
  bountyId: number;
  bountyName: string;
})}
  <div class="flex flex-wrap items-baseline gap-x-2">
    <a
      href={bountyEntryUrl(data.civitaiUrl, row.bountyId, row.entryId)}
      target="_blank"
      rel="noreferrer"
      class="font-medium {LINK_CLASS}"
    >
      {row.fileName}
    </a>
    <code class="text-xs text-dark-2">file #{row.fileId}</code>
    <span class="text-xs text-dark-2">on</span>
    <a
      href={`${data.civitaiUrl}/bounties/${row.bountyId}`}
      target="_blank"
      rel="noreferrer"
      class="text-sm {LINK_CLASS}"
    >
      {row.bountyName}
    </a>
    {#if row.entrant && row.entrantId}
      <a href={userLookupUrl(row.entrantId)} class="text-xs {LINK_CLASS}">{row.entrant}</a>
    {/if}
  </div>
{/snippet}

<header class="page-header">
  <h1>Bounty Entry File Checks</h1>
</header>

{#if refusal}
  <ErrorAlert class="mb-4" message={refusal} />
{/if}

<section class="mb-8">
  <h2 class="mb-1 text-lg font-semibold">Blocked</h2>
  <p class="mb-3 text-sm text-dark-2">
    Files on open model bounties that match another user's model, and files re-blocked after their
    bounty settled. A blocked file can't be awarded or downloaded. Clearing it lifts both, for this
    upload only.
  </p>
  {#if data.blocked.hasMore}
    <p class="mb-2 text-xs text-dark-2">Showing the oldest {data.limit}.</p>
  {/if}
  {#if data.blocked.items.length === 0}
    <p class="text-sm text-dark-2">No blocked files.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.blocked.items as row (row.fileId)}
        {@const done = cleared.has(row.fileId)}
        <li
          class={cn(
            'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
            done && 'opacity-50'
          )}
        >
          {@render entry(row)}
          <p class="mt-1 text-xs text-dark-2">
            {#if row.matchModelId}
              Matches
              <a
                href={`${data.civitaiUrl}/models/${row.matchModelId}`}
                target="_blank"
                rel="noreferrer"
                class={LINK_CLASS}>{row.matchModelName}</a
              >{#if row.matchOwner}&nbsp;by {row.matchOwner}{/if}.
            {:else}
              The matching model is no longer found.
            {/if}
            {#if row.checkedAt}Checked {dateTime(row.checkedAt)}.{/if}
          </p>
          {#if row.bountyRefunded}
            <Badge variant="outline" class="mt-2">bounty refunded</Badge>
          {:else if row.bountyComplete}
            <Badge variant="outline" class="mt-2">bounty complete</Badge>
          {/if}
          {#if done}
            <p class="mt-3 text-sm text-dark-2">Cleared</p>
          {:else}
            <form
              method="POST"
              action="?/clear"
              use:enhance={submit(cleared, row.fileId)}
              class="mt-3 flex flex-col gap-2"
            >
              <input type="hidden" name="fileId" value={row.fileId} />
              <Textarea
                name="reason"
                required
                rows={2}
                placeholder="Why this file is fine (moderators only)"
                bind:value={() => reasons.get(row.fileId) ?? '',
                  (v: string) => reasons.set(row.fileId, v)}
              />
              <div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!(reasons.get(row.fileId) ?? '').trim()}
                >
                  Clear block
                </Button>
              </div>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section class="mb-8">
  <h2 class="mb-1 text-lg font-semibold">Still checking</h2>
  <p class="mb-3 text-sm text-dark-2">
    Files the check tried and failed to read. They can't be awarded until a check succeeds, and their
    bounty won't auto-award at expiry while one is waiting. The check retries them on its own.
  </p>
  {#if data.stuck.hasMore}
    <p class="mb-2 text-xs text-dark-2">Showing the {data.limit} that expire first.</p>
  {/if}
  {#if data.stuck.items.length === 0}
    <p class="text-sm text-dark-2">No files failing the check.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.stuck.items as row (row.fileId)}
        <li class="rounded-lg border border-dark-4 bg-dark-6 p-4">
          {@render entry(row)}
          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-dark-2">
            <Badge variant="secondary">failed {row.failCount}×</Badge>
            {#if row.attemptedAt}<span>last tried {dateTime(row.attemptedAt)}</span>{/if}
            <span>bounty ends {dateTime(row.expiresAt)}</span>
            {#if awardWaiting(row.expiresAt)}
              <Badge variant="outline">auto-award waiting</Badge>
            {/if}
          </div>
          {#if row.lastError}
            <p class="mt-2 rounded-md bg-dark-7 p-2 font-mono text-xs text-dark-0">
              {row.lastError}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section>
  <h2 class="mb-1 text-lg font-semibold">Recently cleared</h2>
  {#if data.cleared.length === 0}
    <p class="text-sm text-dark-2">Nothing cleared yet.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.cleared as row (row.fileId)}
        {@const done = reblocked.has(row.fileId)}
        <li
          class={cn(
            'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
            done && 'opacity-50'
          )}
        >
          {@render entry(row)}
          <p class="mt-1 text-xs text-dark-2">
            Cleared {dateTime(row.clearedAt)}{#if row.moderator}&nbsp;by {row.moderator}{/if}
          </p>
          {#if row.reason}
            <p class="mt-2 rounded-md bg-dark-7 p-2 text-sm text-dark-0">{row.reason}</p>
          {/if}
          {#if done}
            <p class="mt-3 text-sm text-dark-2">Re-blocked</p>
          {:else}
            <form
              method="POST"
              action="?/reblock"
              use:enhance={submit(reblocked, row.fileId)}
              class="mt-3 flex flex-col gap-2"
            >
              <input type="hidden" name="fileId" value={row.fileId} />
              <Textarea
                name="reason"
                required
                rows={2}
                placeholder="Why the clear is undone (moderators only)"
                bind:value={() => reblockReasons.get(row.fileId) ?? '',
                  (v: string) => reblockReasons.set(row.fileId, v)}
              />
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  variant="destructive"
                  disabled={!(reblockReasons.get(row.fileId) ?? '').trim()}
                >
                  Re-block
                </Button>
                {#if row.entryAwarded}
                  <Badge variant="outline">entry awarded</Badge>
                {/if}
                {#if row.bountyRefunded}
                  <Badge variant="outline">bounty refunded</Badge>
                {:else if row.bountyComplete}
                  <Badge variant="outline">bounty complete</Badge>
                {/if}
              </div>
              {#if row.entryAwarded || row.bountyComplete}
                <p class="text-xs text-dark-2">
                  The award stands. Re-blocking withholds the file from everyone but moderators,
                  including whoever paid for it.
                </p>
              {/if}
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
