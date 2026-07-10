<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import PromptHighlight from '$lib/components/PromptHighlight.svelte';
  import { browsingLevels, getBrowsingLevelLabel, NsfwLevel } from '@civitai/shared';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Moderators filter on Blocked too (a mis-rated image can carry the Blocked bit).
  const filterLevels = [...browsingLevels, NsfwLevel.Blocked];
  function toggleLevel(bit: number) {
    const url = new URL(page.url);
    url.searchParams.set('level', String(data.level ^ bit));
    url.searchParams.delete('cursor');
    goto(url.pathname + url.search);
  }

  // imageId → verdict label; optimistic (dims the card + shows the outcome) and cleared on a new page.
  const acted = new SvelteMap<number, string>();
  // imageId → appeal resolution message (bound to each appeal card's textarea).
  const messages = new SvelteMap<number, string>();
  $effect(() => {
    data.items;
    acted.clear();
    messages.clear();
  });

  const submit: SubmitFunction = ({ action, formData }) => {
    const imageId = Number(formData.get('imageId'));
    const a = action.search;
    const verdict = a.includes('accept')
      ? 'Accepted'
      : a.includes('block')
        ? 'Deleted'
        : formData.get('status') === 'Approved'
          ? 'Approved'
          : 'Rejected';
    acted.set(imageId, verdict);
    return async ({ update }) => update({ invalidateAll: false });
  };

  const cardClass = (item: { id: number }) => (acted.has(item.id) ? 'opacity-60' : '');

  const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString() : '');

  // camelCase / snake_case enum → "Title Case" (the main app's getDisplayName/splitUppercase).
  const formatEnum = (s: string) =>
    s
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase());

  // Report.details is free-form JSON; list its primitive key/value pairs for the moderator.
  const detailEntries = (details: unknown): [string, string][] => {
    if (!details || typeof details !== 'object') return [];
    return Object.entries(details as Record<string, unknown>)
      .filter(([, v]) => v != null && typeof v !== 'object' && String(v).trim() !== '')
      .map(([k, v]) => [k, String(v)]);
  };
</script>

<header class="page-header flex flex-wrap items-center justify-between gap-2">
  <h1>{data.title}</h1>
  <div class="flex items-center gap-1">
    {#each filterLevels as bit (bit)}
      {@const on = (data.level & bit) !== 0}
      <button
        class="rounded border px-2 py-1 text-xs font-semibold transition {on
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:border-muted-foreground'}"
        onclick={() => toggleLevel(bit)}
      >
        {getBrowsingLevelLabel(bit)}
      </button>
    {/each}
  </div>
</header>

{#snippet userHeader(item: { username: string | null; profilePicture?: boolean | null })}
  <div class="flex items-center gap-1.5">
    <a
      href={`${data.civitaiUrl}/user/${item.username}`}
      target="_blank"
      rel="noreferrer"
      class="truncate text-xs text-muted-foreground hover:text-foreground"
    >
      {item.username ?? '[deleted]'}
    </a>
    {#if item.profilePicture}
      <Badge class="shrink-0 bg-indigo-500/15 text-indigo-400">Avatar</Badge>
    {/if}
  </div>
{/snippet}

{#snippet verdictBadge(verdict: string)}
  <span class="text-xs font-semibold text-teal-500">✓ {verdict}</span>
{/snippet}

<!-- Accept / Delete for the review + reported queues. A `reportId` couples the report status
     (accept → Unactioned, block → Actioned). `minor` adds the "clear minor flag" accept. -->
{#snippet reviewActions(item: { id: number }, opts: { reportId?: number; minor?: boolean })}
  {@const verdict = acted.get(item.id)}
  {#if verdict}
    {@render verdictBadge(verdict)}
  {:else}
    <div class="flex flex-wrap gap-1.5">
      <form method="POST" action="?/accept" use:enhance={submit}>
        <input type="hidden" name="imageId" value={item.id} />
        {#if opts.reportId}<input type="hidden" name="reportId" value={opts.reportId} />{/if}
        <button
          type="submit"
          class="rounded border border-teal-600/40 px-2 py-0.5 text-xs font-semibold text-teal-400 transition hover:bg-teal-500/10"
        >
          Accept
        </button>
      </form>
      {#if opts.minor}
        <form method="POST" action="?/accept" use:enhance={submit}>
          <input type="hidden" name="imageId" value={item.id} />
          <input type="hidden" name="removeMinorFlag" value="true" />
          <button
            type="submit"
            class="rounded border border-cyan-600/40 px-2 py-0.5 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/10"
          >
            Accept + clear minor
          </button>
        </form>
      {/if}
      <form method="POST" action="?/block" use:enhance={submit}>
        <input type="hidden" name="imageId" value={item.id} />
        {#if opts.reportId}<input type="hidden" name="reportId" value={opts.reportId} />{/if}
        <button
          type="submit"
          class="rounded border border-rose-500/40 px-2 py-0.5 text-xs font-semibold text-rose-400 transition hover:bg-rose-500/10"
        >
          Delete
        </button>
      </form>
    </div>
  {/if}
{/snippet}

{#snippet appealActions(item: { id: number })}
  {@const verdict = acted.get(item.id)}
  {#if verdict}
    {@render verdictBadge(verdict)}
  {:else}
    <div class="flex flex-col gap-1.5">
      <textarea
        placeholder="Resolution message (optional)"
        value={messages.get(item.id) ?? ''}
        oninput={(e) => messages.set(item.id, e.currentTarget.value)}
        rows="2"
        maxlength={1000}
        class="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs"
      ></textarea>
      <div class="flex flex-wrap gap-1.5">
        <form method="POST" action="?/resolveAppeal" use:enhance={submit}>
          <input type="hidden" name="imageId" value={item.id} />
          <input type="hidden" name="status" value="Approved" />
          <input type="hidden" name="resolvedMessage" value={messages.get(item.id) ?? ''} />
          <button
            type="submit"
            class="rounded border border-emerald-600/40 px-2 py-0.5 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-500/10"
          >
            Approve
          </button>
        </form>
        <form method="POST" action="?/resolveAppeal" use:enhance={submit}>
          <input type="hidden" name="imageId" value={item.id} />
          <input type="hidden" name="status" value="Rejected" />
          <input type="hidden" name="resolvedMessage" value={messages.get(item.id) ?? ''} />
          <button
            type="submit"
            class="rounded border border-rose-500/40 px-2 py-0.5 text-xs font-semibold text-rose-400 transition hover:bg-rose-500/10"
          >
            Reject
          </button>
        </form>
      </div>
    </div>
  {/if}
{/snippet}

<!-- One grid per distinct item shape (discriminated by `kind`); the card body then dispatches on
     `data.view`. Both read straight from the server types — no casts, no aliases. -->
{#if data.kind === 'review-highlight'}
  <ImageQueueGrid
    items={data.items}
    civitaiUrl={data.civitaiUrl}
    nextCursor={data.nextCursor}
    empty="No images to review in this queue."
    itemClass={cardClass}
  >
    {#snippet card(item)}
      {@render userHeader(item)}
      {#if data.view === 'minor'}
        <div class="flex flex-col gap-1.5">
          <div class="flex flex-wrap gap-1">
            <Badge
              class={item.minor
                ? 'bg-rose-500/15 text-rose-500'
                : 'bg-emerald-500/15 text-emerald-500'}
            >
              {item.minor ? 'Minor' : 'Not minor'}
            </Badge>
            {#if item.acceptableMinor}
              <Badge class="bg-pink-500/15 text-pink-400">Acceptable minor</Badge>
            {/if}
          </div>
          {#if item.promptHighlight.includesInappropriate}
            <PromptHighlight result={item.promptHighlight} />
          {/if}
          {@render reviewActions(item, { minor: true })}
        </div>
      {:else}
        <div class="flex flex-col gap-1.5">
          <Badge class="w-fit bg-fuchsia-500/15 text-fuchsia-400">Remix source — prompt flagged</Badge>
          <PromptHighlight result={item.promptHighlight} />
          {@render reviewActions(item, {})}
        </div>
      {/if}
    {/snippet}
  </ImageQueueGrid>
{:else if data.kind === 'reported'}
  <ImageQueueGrid
    items={data.items}
    civitaiUrl={data.civitaiUrl}
    nextCursor={data.nextCursor}
    keyOf={(item) => item.report.id}
    empty="No images to review in this queue."
    itemClass={cardClass}
  >
    {#snippet card(item)}
      {@render userHeader(item)}
      <div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
        <div class="flex items-center justify-between gap-2">
          <span class="font-semibold text-amber-400">{item.report.reason}</span>
          {#if item.report.count > 0}
            <span class="shrink-0 text-muted-foreground">+{item.report.count} others</span>
          {/if}
        </div>
        <div class="mt-0.5 text-muted-foreground">
          by
          <a
            href={`${data.civitaiUrl}/user/${item.report.username}`}
            target="_blank"
            rel="noreferrer"
            class="hover:text-foreground">{item.report.username ?? '[deleted]'}</a
          >
          · {new Date(item.report.createdAt).toLocaleDateString()}
        </div>
        {#each detailEntries(item.report.details) as [k, v] (k)}
          <p class="mt-1 text-muted-foreground/90">
            <span class="font-semibold">{formatEnum(k)}:</span>
            {v}
          </p>
        {/each}
      </div>
      {@render reviewActions(item, { reportId: item.report.id })}
    {/snippet}
  </ImageQueueGrid>
{:else if data.kind === 'appeal'}
  <ImageQueueGrid
    items={data.items}
    civitaiUrl={data.civitaiUrl}
    nextCursor={data.nextCursor}
    empty="No images to review in this queue."
    itemClass={cardClass}
  >
    {#snippet card(item)}
      {@render userHeader(item)}
      <div class="flex flex-col gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs">
        <div>
          <span class="font-semibold text-rose-400">Removed:</span>
          {formatEnum(item.tosReason ?? item.blockedFor ?? 'TOS violation')}
          {#if item.removedAt}
            <span class="text-muted-foreground">
              · by {item.moderatorUsername ?? 'moderator'} · {fmt(item.removedAt)}
            </span>
          {/if}
        </div>
        <div>
          <span class="font-semibold text-sky-400">Appeal:</span>
          <span class="text-muted-foreground/90">{item.appeal.message}</span>
        </div>
        <div class="text-muted-foreground">
          by
          <a
            href={`${data.civitaiUrl}/user/${item.appeal.username}`}
            target="_blank"
            rel="noreferrer"
            class="hover:text-foreground">{item.appeal.username ?? '[deleted]'}</a
          >
          · {fmt(item.appeal.createdAt)}
        </div>
        {#if item.reports.length > 0}
          <div class="flex flex-col gap-1">
            <span class="text-muted-foreground">Triggered by</span>
            {#each item.reports as report (report.id)}
              <div class="flex flex-col gap-0.5">
                <Badge class="w-fit bg-orange-500/15 text-orange-400">{report.reason}</Badge>
                {#each detailEntries(report.details) as [k, v] (k)}
                  <p class="ml-1 text-muted-foreground/90">
                    <span class="font-semibold">{formatEnum(k)}:</span>
                    {v}
                  </p>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      </div>
      {@render appealActions(item)}
    {/snippet}
  </ImageQueueGrid>
{:else}
  <ImageQueueGrid
    items={data.items}
    civitaiUrl={data.civitaiUrl}
    nextCursor={data.nextCursor}
    empty="No images to review in this queue."
    itemClass={cardClass}
  >
    {#snippet card(item)}
      {@render userHeader(item)}
      {#if data.view === 'poi'}
        <div class="flex flex-wrap gap-1">
          <Badge class="bg-orange-500/15 text-orange-400">POI</Badge>
          {#each item.reviewTags as reviewTag (reviewTag.id)}
            <Badge class="bg-orange-500/15 font-medium text-orange-300">{reviewTag.name}</Badge>
          {/each}
        </div>
      {:else if data.view === 'tag'}
        <div class="flex flex-wrap gap-1">
          {#each item.reviewTags as reviewTag (reviewTag.id)}
            <Badge class="bg-violet-500/15 text-violet-400">{reviewTag.name}</Badge>
          {:else}
            <span class="text-xs text-muted-foreground">no review tags</span>
          {/each}
        </div>
      {:else if data.view === 'newUser'}
        <div class="flex flex-wrap gap-1">
          <Badge class="bg-sky-500/15 text-sky-400">New user</Badge>
          {#if item.blockedFor}<Badge class="bg-muted">{item.blockedFor}</Badge>{/if}
        </div>
      {:else if data.view === 'modRule'}
        <div class="flex flex-col items-start gap-1">
          <p class="text-xs text-amber-400">{item.ruleReason ?? 'Rule violation'}</p>
          {#if item.ruleDefinition}
            <Popover.Root>
              <Popover.Trigger class="text-[11px] font-medium text-primary hover:underline">
                View rule definition
              </Popover.Trigger>
              <Popover.Content align="start" class="w-[min(28rem,calc(100vw-2rem))]">
                <pre
                  class="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(
                    item.ruleDefinition,
                    null,
                    2
                  )}</pre>
              </Popover.Content>
            </Popover.Root>
          {/if}
        </div>
      {:else}
        <Badge class="w-fit bg-rose-600/20 font-semibold text-rose-500">CSAM — flagged for review</Badge>
      {/if}
      {@render reviewActions(item, {})}
    {/snippet}
  </ImageQueueGrid>
{/if}
