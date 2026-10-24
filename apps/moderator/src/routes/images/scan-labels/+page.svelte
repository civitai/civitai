<script lang="ts">
  import { applyAction } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { imageLookupUrl, userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS } from '$lib/format';
  import { urlWith } from '$lib/url';
  import VoteForm from './VoteForm.svelte';
  import type { VotedItemOwner } from '$lib/server/scan-label.service';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let submitting = $state(false);
  let shownAt = 0;
  $effect.pre(() => {
    void data.card?.token;
    shownAt = Date.now();
  });

  // Blurred so the vote keys work again: the key handler ignores events from the filter controls.
  const setFilter = async (key: 'day' | 'version', value: string) => {
    await goto(urlWith(page.url, { [key]: value }), { keepFocus: true });
    (document.activeElement as HTMLElement | null)?.blur();
  };

  let videoState = $state<'loading' | 'ready' | 'failed'>('loading');
  $effect.pre(() => {
    void data.card?.token;
    videoState = 'loading';
  });

  // A <source> error fires per candidate; only the last one (or the <video>) means nothing can play.
  const onMediaError = (e: Event) => {
    const el = e.target as HTMLElement;
    if (el.tagName === 'VIDEO' || (el.tagName === 'SOURCE' && !el.nextElementSibling)) {
      videoState = 'failed';
    }
  };

  let serverError = $state<string | null>(null);
  // Kept here rather than derived from `form`: a refused vote replaces `form` and would drop the
  // owner of the vote that did land.
  let lastVoted = $state<VotedItemOwner | null>(null);

  const submitVote: SubmitFunction = ({ formData }) => {
    submitting = true;
    serverError = null;
    formData.set('ms', String(Date.now() - shownAt));
    return async ({ result }) => {
      try {
        // An error result must not reload: the reload would serve the same item again and hide
        // that the vote was not recorded.
        if (result.type === 'error') {
          serverError = 'Your vote was not recorded. Try again.';
          return;
        }
        if (result.type === 'success')
          lastVoted = (result.data as { owner?: VotedItemOwner | null } | undefined)?.owner ?? null;
        await applyAction(result);
        // Invalidate on 409 too: the reload claims the next item.
        await invalidateAll();
      } finally {
        submitting = false;
      }
    };
  };

  const versionLabel = $derived(data.version || 'All versions');
</script>

<div class="mx-auto flex max-w-5xl flex-col gap-4">
  <header class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold text-white">Scan labels</h1>
      <p class="text-sm text-dark-2">Should this image be blocked? Three moderators vote on each.</p>
    </div>
    <div class="flex flex-wrap items-end gap-3">
      <div>
        <Label for="scan-label-day" class="text-xs text-dark-2">Flagged on (UTC)</Label>
        <Input
          id="scan-label-day"
          type="date"
          value={data.day}
          onchange={(e) => setFilter('day', e.currentTarget.value)}
          class="mt-1 w-40"
        />
      </div>
      <div>
        <Label for="scan-label-version" class="text-xs text-dark-2">Flagger version</Label>
        <Select.Root
          type="single"
          bind:value={() => data.version, (v) => setFilter('version', v)}
        >
          <Select.Trigger id="scan-label-version" class="mt-1 w-56">{versionLabel}</Select.Trigger>
          <Select.Content>
            <Select.Item value="">All versions</Select.Item>
            {#each data.versions as v (v)}
              <Select.Item value={v}>{v}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    </div>
  </header>

  <dl class="grid grid-cols-3 gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4 text-sm">
    <div>
      <dt class="text-dark-2">My votes today</dt>
      <dd
        class={data.counters.myVotesToday >= data.counters.myQuota
          ? 'text-lg font-semibold text-emerald-400'
          : 'text-lg font-semibold text-dark-0'}
      >
        {data.counters.myVotesToday} / {data.counters.myQuota}
      </dd>
    </div>
    <div>
      <dt class="text-dark-2">Open in this view</dt>
      <dd class="text-lg font-semibold text-dark-0">{data.counters.openInFilter}</dd>
    </div>
    <div>
      <dt class="text-dark-2">Decided today</dt>
      <dd class="text-lg font-semibold text-dark-0">{data.counters.decidedToday}</dd>
    </div>
  </dl>

  {#if serverError}
    <ErrorAlert message={serverError} />
  {:else if form?.error}
    <ErrorAlert message={form.error} />
  {/if}

  {#if lastVoted}
    <p class="rounded-xl border border-dark-4 bg-dark-6 px-4 py-2 text-sm text-dark-2" role="status">
      Last vote:
      <a href={imageLookupUrl(lastVoted.imageId)} class={LINK_CLASS}>image #{lastVoted.imageId}</a>
      · Owner:
      <!-- By id: User Lookup reads an all-digit term as an id first, so a numeric username would open
           someone else's account. -->
      <a href={userLookupUrl(lastVoted.ownerId)} class={LINK_CLASS}>
        {lastVoted.ownerUsername ?? '[deleted]'}
      </a>
      · #{lastVoted.ownerId}
    </p>
  {/if}

  {#if data.card}
    {#key data.card.token}
      <section
        class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 transition-opacity"
        class:opacity-50={submitting}
      >
        <!-- Media events do not bubble; capture on the wrapper hears the inner <video>. -->
        <div
          class="relative flex justify-center"
          onloadeddatacapture={() => (videoState = 'ready')}
          oncanplaycapture={() => (videoState = 'ready')}
          onerrorcapture={onMediaError}
        >
          <!-- Served by the card's token, so the page never names the media itself. -->
          {#if data.card.type === 'video'}
            <video
              class="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
              poster="{data.card.mediaSrc}?v=poster"
              autoplay
              muted
              loop
              playsinline
              preload="metadata"
            >
              <source src="{data.card.mediaSrc}?v=webm" type="video/webm" />
              <source src="{data.card.mediaSrc}?v=mp4" type="video/mp4" />
            </video>
          {:else}
            <img
              src="{data.card.mediaSrc}?v=image"
              alt="Under review"
              width={data.card.width ?? undefined}
              height={data.card.height ?? undefined}
              decoding="async"
              class="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
            />
          {/if}
          {#if data.card.type === 'video' && videoState !== 'ready'}
            <div
              class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-dark-2"
              role="status"
            >
              <span class="rounded-md bg-dark-8/80 px-3 py-1.5">
                {videoState === 'failed' ? 'Video failed to load' : 'Loading video...'}
              </span>
            </div>
          {/if}
        </div>
        <VoteForm token={data.card.token} {submitting} onsubmit={submitVote} />
      </section>
    {/key}
  {:else}
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-center text-sm text-dark-2">
      {#if data.counters.myVotesToday >= data.counters.myQuota}
        You have reached today’s target.
      {/if}
      Nothing left for you in this view. Other moderators may hold the remaining slots for a couple of
      minutes; check back, or widen the filters.
    </section>
  {/if}
</div>
