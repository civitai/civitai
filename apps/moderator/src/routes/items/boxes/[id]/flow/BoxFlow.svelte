<script lang="ts">
  import { enhance } from '$app/forms';
  import { beforeNavigate } from '$app/navigation';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { CATALOG_MAX, type CosmeticEvent, type FlowReward } from '$lib/box-design';
  import { fillByPrice, flowChecklist, groupByDesign, oddsByTeam, type FixTarget } from '$lib/box-flow';
  import { ITEM_DEFINITION_STATUS, type BoxDraft } from '$lib/mystery-box';
  import BasicsStep from './BasicsStep.svelte';
  import { fetchCatalog } from './catalog';
  import ItemsStep from './ItemsStep.svelte';
  import { notify } from './notify';
  import OddsStrip from './OddsStrip.svelte';
  import PublishStep from './PublishStep.svelte';
  import SellStep from './SellStep.svelte';
  import { NEXT_LABEL, STEPS } from './steps';
  import StepNav from './StepNav.svelte';
  import type { FlowUi } from './ui-state';
  import type { Listing } from '../ListingForm.svelte';

  let {
    box,
    initial,
    initialRewards,
    events,
    snapshots,
    listings,
    civitaiUrl,
    canDefine,
    ui = $bindable(),
    onpublished,
  }: {
    box: { id: number; status: string; version: number; updatedAt: string };
    initial: BoxDraft;
    initialRewards: FlowReward[];
    events: CosmeticEvent[];
    snapshots: { version: number; createdAt: Date; createdById: number | null }[];
    listings: Listing[];
    civitaiUrl: string;
    canDefine: boolean;
    ui: FlowUi;
    onpublished: () => void;
  } = $props();

  // Seeded once: +page.svelte remounts this on every write to the box.
  let draft = $state<BoxDraft>(untrack(() => structuredClone(initial)));
  const rewards = new SvelteMap<number, FlowReward>(untrack(() => initialRewards.map((reward) => [reward.id, reward])));
  const initialJson = untrack(() => JSON.stringify(initial));
  const draftJson = $derived(JSON.stringify(draft));
  const dirty = $derived(draftJson !== initialJson);

  let focusTier = $state<string | null>(null);
  let itemsSeen = $state(false);
  let dockHeight = $state(0);
  let filling = $state(false);
  let fillError = $state<string | null>(null);

  $effect(() => {
    if (ui.step === 'items') itemsSeen = true;
  });

  beforeNavigate((navigation) => {
    if (!dirty) return;
    if (navigation.willUnload || !confirm('Leave without saving your changes to this box?')) navigation.cancel();
  });

  const teams = $derived(events.find((entry) => entry.event === draft.event)?.teams ?? []);
  const checklist = $derived(flowChecklist(draft, rewards, teams));
  const odds = $derived(oddsByTeam(draft, rewards, teams));
  const designCount = $derived(groupByDesign(draft.contents, rewards).length);

  /** Captured on submit: by onSuccess the reload has replaced `box`. */
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
    ui.step = target.step;
    if (target.step === 'items') {
      ui.itemsTab = 'box';
      focusTier = target.tierKey ?? null;
    }
  }

  async function fillFromEvent() {
    filling = true;
    fillError = null;
    try {
      const { designs, total } = await fetchCatalog(box.id, new URLSearchParams({ event: draft.event, limit: String(CATALOG_MAX) }));
      if (total > designs.length) throw new Error(`${draft.event} has ${total} designs; this fills at most ${designs.length} at a time.`);
      const result = fillByPrice(draft, rewards, designs, ui.bands);
      draft.tiers = result.tiers;
      draft.contents = result.contents;
      for (const reward of result.rewards) rewards.set(reward.id, reward);
      ui.preset = 'price';
      ui.itemsTab = 'box';
      ui.step = 'items';
      notify(
        `${result.added} items added in 3 tiers.` +
          (result.noPrice || result.noDefinition ? ` Left out: ${result.noPrice} with no shelf price, ${result.noDefinition} needing a definition.` : '')
      );
    } catch (error) {
      fillError = error instanceof Error ? error.message : 'Filling from the event failed.';
    } finally {
      filling = false;
    }
  }

  const order = STEPS.map(([key]) => key);
  const goBack = () => (ui.step = order[Math.max(0, order.indexOf(ui.step) - 1)]);
  const goNext = () => (ui.step = order[Math.min(order.length - 1, order.indexOf(ui.step) + 1)]);
</script>

<form id="box-save" method="POST" action="?/save" use:enhance={saving.enhance} class="hidden">
  <input type="hidden" name="expectedVersion" value={box.version} />
  <input type="hidden" name="expectedUpdatedAt" value={box.updatedAt} />
  <input type="hidden" name="draft" value={draftJson} />
</form>

<StepNav bind:step={ui.step} problems={draft.name.trim() || draft.tiers.length ? checklist.problems.length : 0} />

<div style:padding-bottom="{dockHeight + 16}px">
  <div class={ui.step === 'basics' ? '' : 'hidden'}>
    <BasicsStep bind:draft {events} {teams} {filling} {fillError} onfill={fillFromEvent} />
  </div>
  {#if itemsSeen}
    <div class={ui.step === 'items' ? '' : 'hidden'}>
      <ItemsStep bind:draft bind:ui {rewards} {events} {odds} bind:focusTier boxId={box.id} {dockHeight} {canDefine} />
    </div>
  {/if}
  {#if ui.step === 'publish'}
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
  {#if ui.step === 'sell'}
    <SellStep boxStatus={box.status} {listings} {odds} {dirty} boxName={initial.name} />
  {/if}
</div>

<div class="fixed inset-x-0 bottom-0 z-30 border-t border-dark-4 bg-dark-8/95 px-4 py-2 backdrop-blur md:left-[var(--sidebar-width)]" bind:clientHeight={dockHeight}>
  <div class="mx-auto max-w-[1280px]">
    {#if ui.step !== 'basics'}
      <OddsStrip {odds} designs={designCount} problems={checklist.problems.length} />
    {/if}
    {#if saving.error}<ErrorAlert class="my-2" message={saving.error} />{/if}
    <div class="mt-2 flex gap-2">
      <Button variant="ghost" class={ui.step === 'basics' ? 'invisible' : ''} onclick={goBack}>Back</Button>
      <span class="grow"></span>
      {#if ui.step === 'basics' || ui.step === 'items'}
        <Button type="submit" form="box-save" variant="outline" disabled={saving.submitting || !dirty}>Save</Button>
      {/if}
      {#if ui.step === 'sell'}
        <Button href="/items/boxes">{NEXT_LABEL[ui.step]}</Button>
      {:else}
        <Button disabled={ui.step === 'basics' && !draft.name.trim()} onclick={goNext}>{NEXT_LABEL[ui.step]}</Button>
      {/if}
    </div>
  </div>
</div>
