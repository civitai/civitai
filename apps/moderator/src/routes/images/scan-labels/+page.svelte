<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { urlWith } from '$lib/url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let submitting = $state(false);
  let voteForm = $state<HTMLFormElement | null>(null);
  let shownAt = 0;
  $effect.pre(() => {
    void data.card?.itemId;
    shownAt = Date.now();
  });

  const setFilter = (key: 'day' | 'version', value: string) =>
    goto(urlWith(page.url, { [key]: value }), { keepFocus: true });

  // A refused vote still moves on: every refusal means this item no longer needs this moderator.
  const submitVote: SubmitFunction = ({ formData }) => {
    submitting = true;
    formData.set('ms', String(Date.now() - shownAt));
    return async ({ result }) => {
      await applyAction(result);
      await invalidateAll();
      submitting = false;
    };
  };

  const vote = (block: boolean) => {
    if (!voteForm || submitting) return;
    const button = voteForm.querySelector<HTMLButtonElement>(`button[value="${block ? '1' : '0'}"]`);
    voteForm.requestSubmit(button);
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [role="combobox"], [role="listbox"]')) return;
    if (e.key === 'b' || e.key === 'B') vote(true);
    else if (e.key === 'n' || e.key === 'N') vote(false);
  };

  const versionLabel = $derived(data.version || 'All versions');
</script>

<svelte:window onkeydown={onKeydown} />

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

  {#if form?.error}
    <ErrorAlert message={form.error} />
  {/if}

  {#if data.card}
    {#key data.card.itemId}
      <section class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
        <div class="flex justify-center">
          <EdgeMedia
            src={data.card.url}
            name={data.card.name}
            type={data.card.type === 'video' ? 'video' : 'image'}
            width={1200}
            fit="scale-down"
            anim
            alt="Image under review"
            class="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
          />
        </div>
        <form
          method="POST"
          action="?/vote"
          use:enhance={submitVote}
          bind:this={voteForm}
          class="grid grid-cols-2 gap-3"
        >
          <input type="hidden" name="itemId" value={data.card.itemId} />
          <Button
            type="submit"
            name="block"
            value="1"
            variant="destructive"
            size="lg"
            disabled={submitting}
          >
            Block <span class="ml-2 text-xs opacity-70">B</span>
          </Button>
          <Button
            type="submit"
            name="block"
            value="0"
            variant="secondary"
            size="lg"
            disabled={submitting}
          >
            Don’t block <span class="ml-2 text-xs opacity-70">N</span>
          </Button>
        </form>
      </section>
    {/key}
  {:else}
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-center text-sm text-dark-2">
      Nothing left for you in this view. Other moderators may hold the remaining slots for a couple of
      minutes; check back, or widen the filters.
    </section>
  {/if}
</div>
