<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { page as pageState } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { SvelteSet } from 'svelte/reactivity';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import ImageActionBar from '$lib/components/ImageActionBar.svelte';
  import CannedReasonPicker from '$lib/components/CannedReasonPicker.svelte';
  import { STRIKE_REASONS } from '$lib/moderation-reasons';
  import SuspectFilterBar from './SuspectFilterBar.svelte';
  import type { PageData } from './$types';
  import { writeEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';

  let {
    suspectId,
    suspect,
    filters,
    strikes,
    canAct,
    civitaiUrl,
    strikeError,
    notifyError,
    imagesError,
    imageResult,
    warning,
  }: {
    suspectId: number;
    suspect: NonNullable<PageData['suspect']>;
    filters: PageData['filters'];
    strikes: NonNullable<PageData['strikes']>;
    canAct: boolean;
    civitaiUrl: string;
    strikeError: string | null;
    notifyError: string | null;
    imagesError: string | null;
    imageResult: string | null;
    warning: string | null;
  } = $props();

  let striking = $state(false);
  let strikeReason = $state('');
  let notifying = $state(false);
  let submitting = $state(false);

  const selected = new SvelteSet<string | number>();
  const blockedIds = $derived(
    new Set<string | number>(
      suspect.items.filter((i) => i.ingestion === 'Blocked').map((i) => i.id)
    )
  );

  // This panel owns its writes so a success can tear down what it armed. Inferring that from the
  // returned `warning` left a strike form open with a live submit after the strike had landed.
  const onSubmit = writeEnhancer({
    reload: true,
    onSuccess: () => {
      striking = false;
      notifying = false;
      selected.clear();
    },
    busy: (value) => (submitting = value),
  });

  // A new batch — a page of the grid, a filter change — must not carry the previous selection: those
  // ids would still submit, and they belong to images no longer on screen. Keyed on the URL because
  // `items` is a fresh array after ANY write on the page, which would discard a selection mid-assembly.
  $effect(() => {
    pageState.url.search;
    untrack(() => selected.clear());
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
    <div>
      <h2 class="text-sm font-semibold text-white">
        Reported account · {num(suspect.total)} images
        {#if suspect.blocked > 0}
          <span class="font-normal text-dark-2">· {num(suspect.blocked)} already blocked</span>
        {/if}
      </h2>
      <p class="text-xs text-dark-2">
        {num(suspect.matched)} match the filters; showing {suspect.items.length}.
        {#if suspect.total > suspect.blocked}
          {num(suspect.total - suspect.blocked)} remaining after prior enforcement.
        {/if}
        <a href={userLookupUrl(suspectId, 'reports')} class={LINK_CLASS}>
          Their reports in User Lookup
        </a>.
      </p>
    </div>
    {#if canAct}
      <div class="flex gap-2">
        {#if !striking}
          <Button size="sm" variant="destructive" onclick={() => (striking = true)}>Strike</Button>
        {/if}
        {#if !notifying}
          <Button size="sm" onclick={() => (notifying = true)}>Notify</Button>
        {/if}
      </div>
    {/if}
  </div>

  {#if warning}
    <div
      class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200"
      role="status"
    >
      {warning}
    </div>
  {/if}

  {#if striking}
    <form method="POST" action="?/strike" use:enhance={onSubmit} class="mb-3">
      <input type="hidden" name="userId" value={suspectId} />
      {#if strikeError}
        <div
          class="mb-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
          role="alert"
        >
          {strikeError}
        </div>
      {/if}
      <CannedReasonPicker reasons={STRIKE_REASONS} idPrefix="strike" bind:value={strikeReason} />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={submitting}>
          {submitting ? 'Working…' : 'Issue strike'}
        </Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (striking = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}

  {#if notifying}
    <form method="POST" action="?/notify" use:enhance={onSubmit} class="mb-3">
      <input type="hidden" name="userId" value={suspectId} />
      {#if notifyError}
        <div
          class="mb-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
          role="alert"
        >
          {notifyError}
        </div>
      {/if}
      <Textarea name="message" rows={2} placeholder="What should this user be told?" required />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" disabled={submitting}>Send</Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (notifying = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}

  <div class="mb-4">
    <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Strikes ({strikes.length})</h3>
    {#if strikes.length === 0}
      <p class="text-sm text-dark-2">No strikes on this account.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each strikes as s (s.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant="destructive">strike</Badge>
            <span class="text-dark-0">{s.reason}</span>
            <span class="text-xs text-dark-2">
              {s.createdBy ?? 'unknown'} · {dateTime(s.createdAt)}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Recent content</h3>
</section>

<!-- Keyed on the URL, not on `data`: an unrelated write invalidates `load` and would otherwise reset a
     half-typed filter or an in-progress selection. -->
{#key pageState.url.search}
  <SuspectFilterBar {filters} />
{/key}

{#if imagesError}
  <div
    class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {imagesError}
  </div>
{:else if imageResult}
  <div class="mb-3 rounded-md border border-dark-4 bg-dark-6 p-2 text-sm text-dark-0" role="status">
    {imageResult}
  </div>
{/if}

{#if canAct}
  <ImageActionBar
    {selected}
    selectable={suspect.items.map((i) => i.id)}
    {onSubmit}
    {submitting}
    notify={false}
    blockedIds={blockedIds}
  />
{/if}

<ImageQueueGrid
  items={suspect.items}
  {civitaiUrl}
  nextCursor={suspect.nextCursor}
  selected={canAct ? selected : undefined}
  empty="No images match these filters."
  endLabel="End of this account's content."
  card={imageCard}
/>

{#snippet imageCard(img: {
  tosViolation?: boolean;
  needsReview?: string | null;
  createdAt?: Date;
  ingestion?: string;
  blockedFor?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  isProfilePicture?: boolean;
  hasConnection?: boolean;
})}
  <div class="flex flex-col gap-1.5 p-2 text-xs text-dark-2">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {#if img.ingestion === 'Blocked'}
        <Badge variant="destructive">blocked{img.blockedFor ? `: ${img.blockedFor}` : ''}</Badge>
      {/if}
      {#if img.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
      {#if img.needsReview}<Badge variant="secondary">{img.needsReview}</Badge>{/if}
      <!-- Removing either has consequences beyond the image: one blanks the account's avatar, the
           other pulls an entry out of a bounty. -->
      {#if img.isProfilePicture}<Badge variant="secondary">profile picture</Badge>{/if}
      {#if img.hasConnection}<Badge variant="secondary">attached to a bounty</Badge>{/if}
      <span>{dateTime(img.createdAt ?? null)}</span>
    </div>
    {#if img.prompt}
      <p class="line-clamp-3 wrap-break-word" title={img.prompt}>{img.prompt}</p>
    {/if}
    {#if img.negativePrompt}
      <p class="line-clamp-2 wrap-break-word text-dark-2/70" title={img.negativePrompt}>
        neg: {img.negativePrompt}
      </p>
    {/if}
  </div>
{/snippet}
