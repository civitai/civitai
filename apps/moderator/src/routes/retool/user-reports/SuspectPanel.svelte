<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import type { PageData } from './$types';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';

  let {
    suspectId,
    suspect,
    strikes,
    canAct,
    civitaiUrl,
    strikeError,
    notifyError,
    warning,
    onSubmit,
    submitting,
  }: {
    suspectId: number;
    suspect: NonNullable<PageData['suspect']>;
    strikes: NonNullable<PageData['strikes']>;
    canAct: boolean;
    civitaiUrl: string;
    strikeError: string | null;
    notifyError: string | null;
    warning: string | null;
    onSubmit: SubmitFunction;
    submitting: boolean;
  } = $props();

  let striking = $state(false);
  let notifying = $state(false);

  // A successful strike or notify closes its form; the page reloads, so `form` is fresh each time.
  $effect(() => {
    if (warning !== null) striking = false;
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
        Showing the {suspect.items.length} most recent reviewable{suspect.truncated ? ' of more' : ''}.
        Blocked images are prior enforcement and are counted but not shown.
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
      <Textarea name="reason" rows={2} placeholder="Reason — this text is sent to the user." required />
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

<ImageQueueGrid
  items={suspect.items}
  {civitaiUrl}
  empty="This account has no reviewable content."
  card={imageCard}
/>

{#snippet imageCard(img: { tosViolation?: boolean; needsReview?: string | null; createdAt?: Date })}
  <div class="flex flex-wrap items-baseline gap-x-2 p-2 text-xs text-dark-2">
    {#if img.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
    {#if img.needsReview}<Badge variant="secondary">{img.needsReview}</Badge>{/if}
    <span>{dateTime(img.createdAt ?? null)}</span>
  </div>
{/snippet}
