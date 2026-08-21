<script lang="ts">
  import { enhance } from '$app/forms';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { optimisticEnhancer } from '$lib/form-action';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import QueueHeader from './QueueHeader.svelte';
  import QueueSelectionBar from './QueueSelectionBar.svelte';
  import ReviewActions from './ReviewActions.svelte';
  import AppealActions from './AppealActions.svelte';
  import PromptHighlight from '$lib/components/PromptHighlight.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // The report queue rules on reports, so its verdicts are report statuses. Everywhere else the
  // verdict is about the image.
  const reported = $derived(data.kind === 'reported');
  const acceptedVerdict = $derived(reported ? 'Unactioned' : 'Accepted');

  // CARD KEY → verdict label; optimistic (dims the card + shows the outcome) and cleared on a new page.
  //
  // Keyed like `keyOf` and `selected`, i.e. by report id on the reported queue, NOT by image id. That
  // queue returns one row PER REPORT (`getReportedImageQueue`), so an image with two open reports has
  // two cards — keying on the image marked both when one was actioned, and the sibling report read as
  // handled and got skipped.
  const acted = new SvelteMap<string | number, string>();
  const keyOfItem = (item: { id: number; report?: { id: number } }) => item.report?.id ?? item.id;
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

  const itemKeys = $derived(data.items.map((i) => ('report' in i ? i.report.id : i.id)));

  const selectedItems = $derived(
    data.items.filter((i) => selected.has('report' in i ? i.report.id : i.id))
  );
  // Deduped: two selected reports on one image are two cards but one image, and the action would
  // otherwise be posted `5,5` and report twice the work it did.
  const selectedImageIds = $derived([...new Set(selectedItems.map((i) => i.id))].join(','));
  const selectedReportIds = $derived(
    selectedItems
      .map((i) => ('report' in i ? i.report.id : 0))
      .filter(Boolean)
      .join(',')
  );

  const bulkSubmit = optimisticEnhancer(({ action, formData }) => {
    // The CARD keys the bar acted on. `reportIds` on the reported queue, `imageIds` elsewhere — reading
    // `imageIds` there would mark every card sharing an image, including reports nobody ruled on.
    const ids = String(formData.get(reported ? 'reportIds' : 'imageIds') ?? '')
      .split(',')
      .map(Number)
      .filter(Boolean);
    const verdict = action.search.includes('bulkAccept')
      ? acceptedVerdict
      : action.search.includes('bulkBlock')
        ? 'Removed'
        : formData.get('status') === 'Approved'
          ? 'Approved'
          : 'Rejected';
    for (const id of ids) acted.set(id, verdict);
    selected.clear();
    // The whole batch reverts together: a rejected bulk action changed nothing, and marking any of it
    // handled hides every one of those images from the moderator working the queue.
    return () => {
      for (const id of ids) acted.delete(id);
    };
  });

  const submit = optimisticEnhancer(({ action, formData }) => {
    // Same rule as the bulk bar: the card, not the image.
    const key = Number(formData.get('reportId') ?? formData.get('imageId'));
    const a = action.search;
    const verdict = a.includes('accept')
      ? acceptedVerdict
      : a.includes('block')
        ? 'Removed'
        : formData.get('status') === 'Approved'
          ? 'Approved'
          : 'Rejected';
    acted.set(key, verdict);
    return () => acted.delete(key);
  });

  // Optimistically-unpublished parent Model3D ids (the thumbnail affordance).
  const unpublishedModel3ds = new SvelteSet<number>();
  const unpublishSubmit: SubmitFunction = ({ formData }) => {
    unpublishedModel3ds.add(Number(formData.get('model3dId')));
    return async ({ update }) => update({ invalidateAll: false });
  };

  const cardClass = (item: { id: number; report?: { id: number } }) =>
    acted.has(keyOfItem(item)) ? 'opacity-60' : '';

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

{#if form?.error}
  <div
    class="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200"
    role="alert"
  >
    {form.error}
  </div>
{/if}

<QueueHeader
  title={data.title}
  level={data.level}
  tagIds={data.tagIds}
  excludedTagIds={data.excludedTagIds}
  tagOptions={data.tagOptions}
  {itemKeys}
  {selected}
/>

{#snippet userHeader(item: { username: string | null; profilePicture?: boolean | null })}
  <div class="flex items-center gap-1.5">
    <!-- On the report queue a username is the start of an investigation, not a profile visit, so it
         goes to User Lookup. The other queues rule on one image and the profile is the useful page. -->
    <a
      href={reported && item.username
        ? userLookupUrl(item.username)
        : `${data.civitaiUrl}/user/${item.username}`}
      target={reported && item.username ? undefined : '_blank'}
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

<!-- Accept / Remove for the review queues, Unaction / Remove for the reported one. A `reportId`
     couples the report status (accept → Unactioned, block → Actioned). `minor` adds the "Accept +
     clear minor" button; plain Accept keeps the flag for SFW and auto-clears it for R+ (server-side). -->
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
          <ReviewActions {item} minorQueue verdict={acted.get(keyOfItem(item))} {selected} {submit} />
        </div>
      {:else}
        <div class="flex flex-col gap-1.5">
          <Badge class="w-fit bg-fuchsia-500/15 text-fuchsia-400">Remix source — prompt flagged</Badge>
          <PromptHighlight result={item.promptHighlight} />
          <ReviewActions {item} verdict={acted.get(keyOfItem(item))} {selected} {submit} />
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
          {#if item.report.username}
            <a href={userLookupUrl(item.report.username)} class="hover:text-foreground">
              {item.report.username}
            </a>
          {:else}
            [deleted]
          {/if}
          · {new Date(item.report.createdAt).toLocaleDateString()}
        </div>
        {#each detailEntries(item.report.details) as [k, v] (k)}
          <p class="mt-1 text-muted-foreground/90">
            <span class="font-semibold">{formatEnum(k)}:</span>
            {v}
          </p>
        {/each}
      </div>
      <ReviewActions {item} reportId={item.report.id} {reported} verdict={acted.get(keyOfItem(item))} {selected} {submit} />
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
      <AppealActions {item} verdict={acted.get(keyOfItem(item))} {selected} {messages} {submit} />
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
      <ReviewActions {item} verdict={acted.get(keyOfItem(item))} {selected} {submit} />
      {@render model3dAffordance(item)}
    {/snippet}
  </ImageQueueGrid>
{/if}

<QueueSelectionBar
  {selected}
  imageIds={selectedImageIds}
  reportIds={selectedReportIds}
  submit={bulkSubmit}
  appeal={data.kind === 'appeal'}
  minorQueue={data.view === 'minor'}
  {reported}
/>
