<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
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

  // Include/exclude a review tag (mutually exclusive per tag; toggles off when re-clicked). URL-driven.
  function toggleTag(id: number, mode: 'include' | 'exclude') {
    const inc = new Set(data.tagIds);
    const exc = new Set(data.excludedTagIds);
    const [self, other] = mode === 'include' ? [inc, exc] : [exc, inc];
    other.delete(id);
    if (self.has(id)) self.delete(id);
    else self.add(id);
    const url = new URL(page.url);
    for (const [k, s] of [
      ['tags', inc],
      ['notags', exc],
    ] as const)
      s.size ? url.searchParams.set(k, [...s].join(',')) : url.searchParams.delete(k);
    url.searchParams.delete('cursor');
    goto(url.pathname + url.search);
  }

  // imageId → verdict label; optimistic (dims the card + shows the outcome) and cleared on a new page.
  const acted = new SvelteMap<number, string>();
  // imageId → appeal resolution message (bound to each appeal card's textarea).
  const messages = new SvelteMap<number, string>();
  // Multiselect: selected card keys (image id, or report id on the reported queue).
  const selected = new SvelteSet<string | number>();
  $effect(() => {
    data.items;
    acted.clear();
    messages.clear();
    selected.clear();
  });

  const selectedItems = $derived(
    data.items.filter((i) => selected.has('report' in i ? i.report.id : i.id))
  );
  const selectedImageIds = $derived(selectedItems.map((i) => i.id).join(','));
  const selectedReportIds = $derived(
    selectedItems
      .map((i) => ('report' in i ? i.report.id : 0))
      .filter(Boolean)
      .join(',')
  );

  const bulkSubmit: SubmitFunction = ({ action, formData }) => {
    const ids = String(formData.get('imageIds') ?? '')
      .split(',')
      .map(Number)
      .filter(Boolean);
    const verdict = action.search.includes('bulkAccept')
      ? 'Accepted'
      : action.search.includes('bulkBlock')
        ? 'Deleted'
        : formData.get('status') === 'Approved'
          ? 'Approved'
          : 'Rejected';
    for (const id of ids) acted.set(id, verdict);
    selected.clear();
    return async ({ update }) => update({ invalidateAll: false });
  };

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

  // Optimistically-unpublished parent Model3D ids (the thumbnail affordance).
  const unpublishedModel3ds = new SvelteSet<number>();
  const unpublishSubmit: SubmitFunction = ({ formData }) => {
    unpublishedModel3ds.add(Number(formData.get('model3dId')));
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

    {#if data.tagOptions.length > 0}
      {@const activeCount = data.tagIds.length + data.excludedTagIds.length}
      <Popover.Root>
        <Popover.Trigger
          class="rounded border border-border px-2 py-1 text-xs font-semibold text-muted-foreground transition hover:border-muted-foreground"
        >
          Tags{activeCount > 0 ? ` (${activeCount})` : ''}
        </Popover.Trigger>
        <Popover.Content align="end" class="max-h-[60vh] w-64 overflow-y-auto">
          <p class="mb-1 text-xs font-semibold uppercase text-muted-foreground">
            Filter by review tag
          </p>
          <div class="flex flex-col gap-0.5">
            {#each data.tagOptions as tag (tag.id)}
              {@const inc = data.tagIds.includes(tag.id)}
              {@const exc = data.excludedTagIds.includes(tag.id)}
              <div class="flex items-center gap-2 text-xs">
                <span class="flex-1 truncate">{tag.name}</span>
                <button
                  title="Include"
                  onclick={() => toggleTag(tag.id, 'include')}
                  class="rounded border px-1.5 font-semibold transition {inc
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-border text-emerald-500 hover:bg-emerald-500/10'}">+</button
                >
                <button
                  title="Exclude"
                  onclick={() => toggleTag(tag.id, 'exclude')}
                  class="rounded border px-1.5 font-semibold transition {exc
                    ? 'border-rose-600 bg-rose-600 text-white'
                    : 'border-border text-rose-500 hover:bg-rose-500/10'}">−</button
                >
              </div>
            {/each}
          </div>
        </Popover.Content>
      </Popover.Root>
    {/if}
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
     (accept → Unactioned, block → Actioned). `minor` adds the "Accept + clear minor" button; plain
     Accept keeps the flag for SFW and auto-clears it for R+ (handled server-side). -->
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

<!-- When the image is a Model3D's @unique thumbnail: link the parent + one-click unpublish it. -->
{#snippet model3dAffordance(item: { model3d: { id: number; name: string; status: string } | null })}
  {#if item.model3d}
    {@const m = item.model3d}
    {@const unpublished = unpublishedModel3ds.has(m.id) || m.status === 'Unpublished'}
    <div
      class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-indigo-500/30 bg-indigo-500/5 p-2 text-xs"
    >
      <span class="font-semibold text-indigo-400">3D Model thumbnail</span>
      <a
        href={`${data.civitaiUrl}/3d-models/${m.id}`}
        target="_blank"
        rel="noreferrer"
        class="text-muted-foreground hover:text-foreground">view parent</a
      >
      {#if unpublished}
        <span class="text-muted-foreground">· unpublished</span>
      {:else}
        <form method="POST" action="?/unpublishModel3d" use:enhance={unpublishSubmit}>
          <input type="hidden" name="model3dId" value={m.id} />
          <button
            type="submit"
            class="rounded border border-rose-500/40 px-2 py-0.5 font-semibold text-rose-400 transition hover:bg-rose-500/10"
          >
            Unpublish parent
          </button>
        </form>
      {/if}
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
    {selected}
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
          {#if item.promptHighlight.hasHighlights}
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
      {@render model3dAffordance(item)}
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
    {selected}
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
      {@render model3dAffordance(item)}
    {/snippet}
  </ImageQueueGrid>
{:else if data.kind === 'appeal'}
  <ImageQueueGrid
    items={data.items}
    civitaiUrl={data.civitaiUrl}
    nextCursor={data.nextCursor}
    empty="No images to review in this queue."
    itemClass={cardClass}
    {selected}
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
      {@render model3dAffordance(item)}
    {/snippet}
  </ImageQueueGrid>
{:else}
  <ImageQueueGrid
    items={data.items}
    civitaiUrl={data.civitaiUrl}
    nextCursor={data.nextCursor}
    empty="No images to review in this queue."
    itemClass={cardClass}
    {selected}
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
      {@render model3dAffordance(item)}
    {/snippet}
  </ImageQueueGrid>
{/if}

{#snippet bulkButton(action: string, label: string, cls: string, extra: Record<string, string> = {})}
  <form method="POST" {action} use:enhance={bulkSubmit}>
    <input type="hidden" name="imageIds" value={selectedImageIds} />
    <input type="hidden" name="reportIds" value={selectedReportIds} />
    {#each Object.entries(extra) as [k, v] (k)}
      <input type="hidden" name={k} value={v} />
    {/each}
    <button type="submit" class="rounded border px-3 py-1 text-xs font-semibold transition {cls}">
      {label}
    </button>
  </form>
{/snippet}

{#if selected.size > 0}
  <!-- spacer so the fixed bar can't cover the last row / Next button -->
  <div class="h-20"></div>
  <div
    class="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 py-3 backdrop-blur"
  >
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
      <span class="text-sm font-semibold">{selected.size} selected</span>
      <button
        onclick={() => selected.clear()}
        class="text-xs text-muted-foreground hover:text-foreground">Clear</button
      >
      <div class="ml-auto flex flex-wrap gap-2">
        {#if data.kind === 'appeal'}
          {@render bulkButton('?/bulkResolveAppeal', 'Approve', 'border-emerald-600/40 text-emerald-400 hover:bg-emerald-500/10', { status: 'Approved' })}
          {@render bulkButton('?/bulkResolveAppeal', 'Reject', 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10', { status: 'Rejected' })}
        {:else}
          {@render bulkButton('?/bulkAccept', 'Accept', 'border-teal-600/40 text-teal-400 hover:bg-teal-500/10')}
          {#if data.view === 'minor'}
            {@render bulkButton('?/bulkAccept', 'Accept + clear minor', 'border-cyan-600/40 text-cyan-400 hover:bg-cyan-500/10', { removeMinorFlag: 'true' })}
          {/if}
          {@render bulkButton('?/bulkBlock', 'Delete', 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10')}
        {/if}
      </div>
    </div>
  </div>
{/if}
