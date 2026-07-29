<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { SheetFooter } from '@civitai/ui/components/ui/sheet/index.js';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import {
    MIN_ACCESS_PRICE,
    MIN_GENERATION_PRICE,
    MAX_GENERATION_TRIAL_LIMIT,
    DEFAULT_GENERATION_TRIAL_LIMIT,
  } from '$lib/monetization/early-access';
  import type { CreatorModelVersion } from '$lib/server/models';

  // The per-version paid-access editor (timed Early Access + permanent Paid Access) rendered inside the
  // licensing drawer. Owns the editable pricing state (`ea`) and every gating decision derived from the
  // version + the creator's caps/score. Remounted per version by the parent (`{#key version.id}`).
  let {
    version,
    onClose,
    maxEarlyAccessDays,
    canSellIndefinitely,
    permanentCap,
    permanentUsed,
    earlyAccessUsed,
    earlyAccessCap,
    tier,
  }: {
    version: CreatorModelVersion;
    onClose: () => void;
    maxEarlyAccessDays: number;
    canSellIndefinitely: boolean;
    permanentCap: number | null;
    permanentUsed: number;
    earlyAccessUsed: number;
    earlyAccessCap: number;
    tier: string | null;
  } = $props();

  const permAtCap = $derived(
    permanentCap !== null && permanentCap > 0 && permanentUsed >= permanentCap
  );

  function seed(v: CreatorModelVersion) {
    const c = v.earlyAccessConfig;
    // Timed early access can't be started on a published version or without score — default new gates to
    // permanent when only that's available. Clamp a seeded duration to the score-based max.
    const timedNewOk = maxEarlyAccessDays > 0 && v.status !== 'Published';
    return {
      timeframe: Math.min(c?.timeframe ?? 7, maxEarlyAccessDays || Infinity),
      permanent: c?.permanent ?? (!timedNewOk && canSellIndefinitely),
      accessPrice: (c?.accessPrice ?? MIN_ACCESS_PRICE) as number | undefined,
      generationPrice: c?.generationPrice as number | undefined,
      freePreviewGenerations: (c?.freePreviewGenerations ??
        DEFAULT_GENERATION_TRIAL_LIMIT) as number | undefined,
      donationGoalEnabled: c?.donationGoalEnabled ?? false,
      donationGoal: c?.donationGoal as number | undefined,
    };
  }
  // Seed once from the version at mount (the parent remounts via `{#key version.id}` on open).
  let ea = $state(untrack(() => seed(version)));

  // A donation goal is create-once (the endpoint never updates or removes it), so once a version has one
  // the amount is locked here — reflected, not editable. Timed access only; permanent has none.
  const hadDonationGoal = $derived(!!version.earlyAccessConfig?.donationGoalEnabled);
  // The permanent option stays available to an already-permanent version even if membership lapsed or the
  // tier is at capacity, so an edit can't strand the creator (mirrors the main-app carve-out).
  const alreadyPermanent = $derived(!!version.earlyAccessConfig?.permanent);
  const canChoosePermanent = $derived(alreadyPermanent || (canSellIndefinitely && !permAtCap));
  const permBlocked = $derived(permAtCap && !alreadyPermanent);
  // A version already on a timed gate stays editable regardless of score/publish state.
  const timedAlreadySet = $derived(!!version.earlyAccessConfig && !alreadyPermanent);
  // Timed early access can't be *started* on a published version (nor without score); permanent still can.
  const canChooseTimed = $derived(
    timedAlreadySet || (maxEarlyAccessDays > 0 && version.status !== 'Published')
  );
  const tierLabel = $derived(tier ? tier[0].toUpperCase() + tier.slice(1) : '');
  // Usage control gates paid access: Download (download + gen) and Generation (on-site gen only, no
  // download charge) can be gated; other controls can't. Undefined defaults to Download.
  const usageControl = $derived(version.usageControl);
  const paidAccessUsageOk = $derived(
    !usageControl || usageControl === 'Download' || usageControl === 'Generation'
  );
  const isGenOnly = $derived(usageControl === 'Generation');
  // Shown in the pricing card so the creator knows why the fields differ (gen-only has no download tier).
  const usageLabel = $derived(isGenOnly ? 'Generation only' : 'Download + generation');

  const eaEnhance =
    () =>
    async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await event.update({ reset: false });
      if (event.result.type === 'success') {
        toast.success(
          event.result.data?.earlyAccessCleared ? 'Early access turned off' : 'Early access saved'
        );
        onClose();
        await invalidateAll();
      } else if (event.result.type === 'failure') {
        toast.error(String(event.result.data?.error ?? 'Failed to save early access'));
      }
    };
</script>

<section class="flex flex-col gap-4 border-t border-dark-4 pt-6">
  <div class="flex flex-col gap-1">
    <span class="text-sm font-medium text-white">Early &amp; paid access</span>
    <span class="text-xs text-dark-2">
      Gate this version behind payment — for a limited time, or permanently.
    </span>
  </div>

  {#if !paidAccessUsageOk}
    <p class="rounded-lg border border-dark-4 p-3 text-xs text-dark-2">
      Paid access isn't available for this version — it's set to API-only generation, not download or
      on-site generation.
    </p>
  {:else if !canChooseTimed && !canChoosePermanent && !version.earlyAccessConfig}
    <p class="rounded-lg border border-dark-4 p-3 text-xs text-dark-2">
      {#if version.status === 'Published'}
        Early access can't be started after a version is published. Permanent paid access needs an
        active Creator Program membership.
      {:else}
        Early access isn't available for your account yet — it unlocks as your creator score grows.
        Permanent paid access needs an active Creator Program membership.
      {/if}
    </p>
  {:else}
    <form method="POST" action="?/setEarlyAccess" use:enhance={eaEnhance} class="flex flex-col gap-4">
      <input type="hidden" name="versionId" value={version.id} />
      <input type="hidden" name="usageControl" value={usageControl ?? 'Download'} />

      <input type="hidden" name="permanent" value={ea.permanent ? 'true' : 'false'} />
      <div class="flex flex-col gap-2">
        <div class="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!canChooseTimed}
            onclick={() => canChooseTimed && (ea.permanent = false)}
            class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors {!ea.permanent
              ? 'border-blue-4 bg-blue-4/10'
              : 'border-dark-4 hover:border-dark-3'} {!canChooseTimed
              ? 'cursor-not-allowed opacity-50'
              : ''}"
          >
            <span class="w-fit rounded-full bg-blue-4/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-3">Timed</span>
            <span class="text-sm font-semibold text-white">Early Access</span>
            <span class="text-xs text-dark-3">Becomes free when the window ends.</span>
          </button>
          <button
            type="button"
            disabled={!canChoosePermanent}
            onclick={() => canChoosePermanent && (ea.permanent = true)}
            class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors {ea.permanent
              ? 'border-[#9775fa] bg-[#9775fa]/10'
              : 'border-dark-4 hover:border-dark-3'} {!canChoosePermanent
              ? 'cursor-not-allowed opacity-50'
              : ''}"
          >
            <span class="w-fit rounded-full bg-[#9775fa]/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#d0bfff]">Permanent</span>
            <span class="text-sm font-semibold text-white">Paid Access</span>
            <span class="text-xs text-dark-3">Always requires purchase.</span>
          </button>
        </div>
        {#if !canChooseTimed && version.status === 'Published'}
          <span class="text-xs text-dark-3">
            Early access can't be started after a version is published — use permanent paid access instead.
          </span>
        {/if}
        {#if !canChoosePermanent}
          <span class="text-xs text-dark-3">
            {#if !canSellIndefinitely}
              Permanent access requires an active Creator Program membership.
            {:else}
              You've reached your tier's permanent-access limit ({permanentUsed} of {permanentCap}).
            {/if}
          </span>
        {/if}
      </div>

      {#if ea.permanent}
        <input type="hidden" name="timeframe" value="0" />
        <div class="text-xs {permBlocked ? 'text-yellow-5' : 'text-dark-3'}">
          {#if permanentCap === null}
            Paid access {permanentUsed} set · unlimited{tierLabel ? ` · ${tierLabel} tier` : ''}
          {:else}
            Paid access {permanentUsed} of {permanentCap} used{tierLabel
              ? ` · ${tierLabel} tier`
              : ''}{permBlocked ? ' — limit reached' : ''}
          {/if}
        </div>
      {:else}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-dark-1">Early access duration (days)</span>
          <NumberInput name="timeframe" min={0} max={maxEarlyAccessDays} bind:value={ea.timeframe} class="w-32" />
          <span class="text-xs text-dark-3">
            Up to {maxEarlyAccessDays} day{maxEarlyAccessDays === 1 ? '' : 's'} at your creator level — set 0 to turn early access off.
          </span>
        </label>
        <div class="text-xs text-dark-3">
          Early access {earlyAccessUsed} of {earlyAccessCap} active · up to {maxEarlyAccessDays} day{maxEarlyAccessDays === 1 ? '' : 's'}
        </div>
      {/if}

      <div class="flex flex-col gap-3 rounded-lg border border-dark-4 p-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-semibold text-white">Pricing</span>
          <span
            class="rounded-full border border-dark-4 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-dark-2"
            title="This version's usage control determines what buyers can purchase."
          >
            {usageLabel}
          </span>
        </div>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-dark-1">Price for access <span class="text-red-6">*</span></span>
          <NumberInput name="accessPrice" min={MIN_ACCESS_PRICE} bind:value={ea.accessPrice} class="w-40" />
          <span class="text-xs text-dark-3">
            {isGenOnly
              ? 'What buyers pay to generate with this version on-site.'
              : 'Buyers unlock download + generation.'}
          </span>
        </label>
        {#if !isGenOnly}
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-dark-1">Generation-only price</span>
            <NumberInput
              name="generationPrice"
              min={MIN_GENERATION_PRICE}
              max={ea.accessPrice}
              bind:value={ea.generationPrice}
              class="w-40"
            />
            <span class="text-xs text-dark-3">
              Defaults to the access price. Lower it to offer a cheaper generation-only tier.
            </span>
          </label>
        {/if}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-dark-1">Free preview generations</span>
          <NumberInput
            name="freePreviewGenerations"
            min={0}
            max={MAX_GENERATION_TRIAL_LIMIT}
            bind:value={ea.freePreviewGenerations}
            placeholder="0"
            class="w-32"
          />
          <span class="text-xs text-dark-3">
            Free test generations before purchase is required — clear or set 0 for none.
          </span>
        </label>
      </div>

      {#if !ea.permanent}
        <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
          <div class="flex items-center gap-2">
            <Checkbox id="ea-dg" name="donationGoalEnabled" bind:checked={ea.donationGoalEnabled} disabled={hadDonationGoal} />
            <Label for="ea-dg" class="cursor-pointer text-sm font-normal text-white">
              Let the community unlock this early
            </Label>
          </div>
          <span class="text-xs text-dark-3">
            If the goal is met before the window ends, early access ends and the version becomes free for everyone.
          </span>
          {#if ea.donationGoalEnabled}
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-dark-2">Goal amount (⚡)</span>
              <NumberInput name="donationGoal" min={0} bind:value={ea.donationGoal} disabled={hadDonationGoal} class="w-40" />
            </label>
            {#if hadDonationGoal}
              <span class="text-xs text-dark-3">
                This goal is already set and can't be changed here — manage it on civitai.com.
              </span>
            {/if}
          {/if}
        </div>
      {/if}

      {#if !ea.accessPrice || ea.accessPrice <= 0}
        <p class="text-xs text-yellow-5">
          Set a price for access to turn on {ea.permanent ? 'paid' : 'early'} access.
        </p>
      {:else if !ea.permanent && !ea.timeframe}
        <p class="text-xs text-dark-3">A duration of 0 turns early access off when you save.</p>
      {/if}

      <SheetFooter class="flex-col gap-2 p-0">
        <Button type="submit">{ea.permanent ? 'Save paid access' : 'Save early access'}</Button>
        {#if version.earlyAccessConfig}
          <Button type="submit" name="clear" value="true" variant="outline">
            {ea.permanent ? 'Turn off paid access' : 'Turn off early access'}
          </Button>
        {/if}
      </SheetFooter>
    </form>
  {/if}
</section>
