<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { notify } from './notify';
  import { isDefined, type CatalogDesign, type FlowReward } from '$lib/box-design';
  import {
    addDesigns,
    applyPricePreset,
    bandOf,
    DEFAULT_BANDS,
    flowChecklist,
    groupByDesign,
    oddsByTeam,
    PRICE_TIERS,
    type FixTarget,
    type TierPreset,
  } from '$lib/box-flow';
  import { ITEM_DEFINITION_STATUS, type BoxDraft } from '$lib/mystery-box';
  import BasicsStep from './BasicsStep.svelte';
  import ItemsStep from './ItemsStep.svelte';
  import OddsStrip from './OddsStrip.svelte';
  import PublishStep from './PublishStep.svelte';
  import SellStep from './SellStep.svelte';
  import StepNav from './StepNav.svelte';
  import type { FlowStep } from './steps';
  import type { Listing } from '../ListingForm.svelte';

  let {
    box,
    initial,
    initialRewards,
    events,
    snapshots,
    listings,
    civitaiUrl,
    step = $bindable(),
    dirty = $bindable(false),
    onpublished,
  }: {
    box: { id: number; status: string; version: number; updatedAt: string };
    initial: BoxDraft;
    initialRewards: FlowReward[];
    events: { event: string; teams: string[] }[];
    snapshots: { version: number; createdAt: Date; createdById: number | null }[];
    listings: Listing[];
    civitaiUrl: string;
    step: FlowStep;
    dirty?: boolean;
    /** The save that just ran was the publish: the next thing to do is sell it. */
    onpublished: () => void;
  } = $props();

  // Seeded once: +page.svelte remounts this on every write to the box.
  let draft = $state<BoxDraft>(untrack(() => structuredClone(initial)));
  const rewards = new SvelteMap<number, FlowReward>(untrack(() => initialRewards.map((reward) => [reward.id, reward])));
  const startsOnPrice = untrack(
    () => initial.tiers.length > 0 && initial.tiers.every((tier) => PRICE_TIERS.some((preset) => preset.key === tier.key))
  );
  let preset = $state<TierPreset>(startsOnPrice ? 'price' : 'custom');
  let bands = $state({ ...DEFAULT_BANDS });
  let itemsTab = $state<'catalog' | 'box'>('catalog');
  let focusTier = $state<string | null>(null);
  let itemsSeen = $state(false);
  let dockHeight = $state(0);
  let filling = $state(false);
  let fillError = $state<string | null>(null);

  $effect(() => {
    dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  });
  $effect(() => {
    if (step === 'items') itemsSeen = true;
  });

  const teams = $derived(events.find((entry) => entry.event === draft.event)?.teams ?? []);
  const checklist = $derived(flowChecklist(draft, rewards, teams));
  const odds = $derived(oddsByTeam(draft, rewards, teams));
  const designCount = $derived(groupByDesign(draft.contents, rewards).length);

  /** Whether the save in flight was the first one a draft gets published by; read when it is sent, before the reload replaces `box`. */
  let submittedAsDraft = false;
  const saving = new FormState({
    onSubmit: () => (submittedAsDraft = box.status === ITEM_DEFINITION_STATUS.draft),
    onSuccess: (data) => {
      const saved = data?.saved as { status: string } | undefined;
      if (submittedAsDraft && saved?.status === ITEM_DEFINITION_STATUS.published) onpublished();
      else notify('Saved');
    },
    reload: true,
    reset: false,
  });

  function fix(target: FixTarget) {
    step = target.step;
    if (target.step === 'items') {
      itemsTab = 'box';
      focusTier = target.tierKey ?? null;
    }
  }

  /** Every priced, defined design of the event goes into the price tiers. One request, capped by the catalog. */
  async function fillFromEvent() {
    filling = true;
    fillError = null;
    try {
      const params = new URLSearchParams({ event: draft.event, limit: '480' });
      const response = await fetch(`/items/boxes/${box.id}/catalog?${params}`);
      if (!response.ok) throw new Error(`The catalog answered ${response.status}.`);
      const { designs, total } = (await response.json()) as { designs: CatalogDesign[]; total: number };
      if (total > designs.length) throw new Error(`${draft.event} has ${total} designs; this fills at most ${designs.length} at a time.`);
      const base = applyPricePreset(draft, rewards, bands);
      let contents = base.contents;
      let added = 0;
      const noPrice = designs.filter((design) => design.shelf === null).length;
      const noDefinition = designs.filter((design) => design.shelf !== null && !isDefined(design)).length;
      for (const tier of PRICE_TIERS) {
        const picks = designs.filter(
          (design) => design.shelf !== null && isDefined(design) && bandOf(design.shelf, bands) === tier.key
        );
        const result = addDesigns(contents, picks, tier.key);
        added += result.contents.length - contents.length;
        contents = result.contents;
        for (const reward of result.rewards) rewards.set(reward.id, reward);
      }
      draft.tiers = base.tiers;
      draft.contents = contents;
      preset = 'price';
      itemsTab = 'box';
      step = 'items';
      notify(
        `${added} items added in 3 tiers.` +
          (noPrice || noDefinition ? ` Left out: ${noPrice} with no shelf price, ${noDefinition} needing a definition.` : '')
      );
    } catch (error) {
      fillError = error instanceof Error ? error.message : 'Filling from the event failed.';
    } finally {
      filling = false;
    }
  }

  const ORDER: FlowStep[] = ['basics', 'items', 'publish', 'sell'];
  const NEXT_LABEL: Record<FlowStep, string> = {
    basics: 'Pick items',
    items: 'Check and publish',
    publish: 'Sell it',
    sell: 'Done',
  };
  const goBack = () => (step = ORDER[Math.max(0, ORDER.indexOf(step) - 1)]);
  const goNext = () => (step = ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(step) + 1)]);
</script>

<svelte:window onbeforeunload={(event) => dirty && event.preventDefault()} />

<form id="box-save" method="POST" action="?/save" use:enhance={saving.enhance} class="hidden">
  <input type="hidden" name="expectedVersion" value={box.version} />
  <input type="hidden" name="expectedUpdatedAt" value={box.updatedAt} />
  <input type="hidden" name="draft" value={JSON.stringify(draft)} />
</form>

<StepNav bind:step problems={draft.name.trim() || draft.tiers.length ? checklist.problems.length : 0} />

<div style:padding-bottom="{dockHeight + 16}px">
  <div class={step === 'basics' ? '' : 'hidden'}>
    <BasicsStep bind:draft {events} {teams} {filling} {fillError} onfill={fillFromEvent} />
  </div>
  {#if itemsSeen}
    <div class={step === 'items' ? '' : 'hidden'}>
      <ItemsStep bind:draft {rewards} {events} {odds} bind:bands bind:preset bind:focusTier bind:tab={itemsTab} boxId={box.id} {dockHeight} />
    </div>
  {/if}
  {#if step === 'publish'}
    <PublishStep
      {box}
      {draft}
      {snapshots}
      {civitaiUrl}
      {dirty}
      problems={checklist.problems}
      passed={checklist.passed}
      {odds}
      designs={designCount}
      {saving}
      onfix={fix}
    />
  {/if}
  {#if step === 'sell'}
    <SellStep boxStatus={box.status} {listings} {odds} {dirty} boxName={initial.name} />
  {/if}
</div>

<div class="fixed inset-x-0 bottom-0 z-30 md:left-[var(--sidebar-width)] border-t border-dark-4 bg-dark-8/95 px-4 py-2 backdrop-blur" bind:clientHeight={dockHeight}>
  <div class="mx-auto max-w-[1280px]">
    {#if step !== 'basics'}
      <OddsStrip {odds} designs={designCount} problems={checklist.problems.length} />
    {/if}
    {#if saving.error}<ErrorAlert class="my-2" message={saving.error} />{/if}
    <div class="mt-2 flex gap-2">
      <Button variant="ghost" class={step === 'basics' ? 'invisible' : ''} onclick={goBack}>Back</Button>
      <span class="grow"></span>
      {#if step !== 'sell'}
        <Button type="submit" form="box-save" variant="outline" disabled={saving.submitting || !dirty}>Save</Button>
        <Button disabled={step === 'basics' && !draft.name.trim()} onclick={goNext}>{NEXT_LABEL[step]}</Button>
      {:else}
        <Button href="/items/boxes" disabled={dirty}>{NEXT_LABEL[step]}</Button>
      {/if}
    </div>
  </div>
</div>
