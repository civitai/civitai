<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { boxChecklist, ITEM_DEFINITION_STATUS, type BoxDraft, type RewardInfo } from '$lib/mystery-box';
  import DetailsPanel from './DetailsPanel.svelte';
  import TiersPanel from './TiersPanel.svelte';
  import ContentsPanel from './ContentsPanel.svelte';
  import OddsPreview from './OddsPreview.svelte';

  let {
    box,
    initial,
    initialRewards,
    events,
    dirty = $bindable(false),
  }: {
    box: { id: number; status: string; version: number; updatedAt: string };
    initial: BoxDraft;
    initialRewards: RewardInfo[];
    events: { event: string; teams: string[] }[];
    dirty?: boolean;
  } = $props();

  // Seeded once: +page.svelte remounts this on every write to the box.
  let draft = $state<BoxDraft>(untrack(() => structuredClone(initial)));
  const rewards = new SvelteMap<number, RewardInfo>(
    untrack(() => initialRewards.map((reward) => [reward.id, reward]))
  );

  $effect(() => {
    dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  });
  const teams = $derived(events.find((e) => e.event === draft.event)?.teams ?? []);
  const problems = $derived(boxChecklist(draft, rewards, teams));
  const isDraft = $derived(box.status === ITEM_DEFINITION_STATUS.draft);

  const saving = new FormState({ onSuccess: null, reload: true, reset: false });
</script>

<div class="mb-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
  <div class="space-y-4">
    <DetailsPanel bind:draft {events} {teams} />
    <TiersPanel bind:draft />
    <ContentsPanel bind:draft {rewards} {teams} boxId={box.id} />
  </div>
  <div class="space-y-4">
    <OddsPreview {draft} {rewards} {teams} />

    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h2 class="mb-2 text-base font-semibold text-white">Checklist</h2>
      {#if problems.length}
        <ul class="list-disc space-y-1 pl-5 text-sm text-red-300">
          {#each problems as problem, i (i)}
            <li>{problem}</li>
          {/each}
        </ul>
        <p class="mt-2 text-xs text-dark-2">
          {isDraft
            ? 'A draft saves anyway; it publishes once these are fixed.'
            : 'A published box saves only once these are fixed.'}
        </p>
      {:else}
        <p class="text-sm text-dark-0">Every tier holds something for every team.</p>
      {/if}
      {#if teams.length === 0}
        <p class="mt-2 text-xs text-dark-2">
          No teams: buyers draw only cosmetics made for no team.
        </p>
      {/if}
    </section>

    <form method="POST" action="?/save" use:enhance={saving.enhance} class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <input type="hidden" name="expectedVersion" value={box.version} />
      <input type="hidden" name="expectedUpdatedAt" value={box.updatedAt} />
      <input type="hidden" name="draft" value={JSON.stringify(draft)} />
      <p class="mb-3 text-xs text-dark-2">
        {#if isDraft}
          Publishing writes the odds history's first entry. A draft is shown nowhere.
        {:else}
          Saving a change to tiers, weights, contents or the event starts a new version and adds it
          to the public odds history.
        {/if}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" variant={isDraft ? 'outline' : 'default'} disabled={saving.submitting || !dirty}>
          Save
        </Button>
        {#if isDraft}
          <Button type="submit" formaction="?/publish" disabled={saving.submitting || problems.length > 0}>
            {dirty ? 'Save and publish' : 'Publish'}
          </Button>
        {/if}
        {#if dirty}
          <span class="text-xs text-amber-300">Unsaved changes</span>
        {/if}
      </div>
      {#if saving.error}
        <ErrorAlert class="mt-3" message={saving.error} />
      {/if}
    </form>
  </div>
</div>
