<script lang="ts">
  import { untrack } from 'svelte';
  import { formatPricingAllowance, isAlreadyPriced, pricingAllowanceState } from '@civitai/buzz';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { SheetFooter } from '@civitai/ui/components/ui/sheet/index.js';
  import UsageControlPicker from '$lib/components/monetization/UsageControlPicker.svelte';
  import PaidAccessFields from '$lib/components/monetization/PaidAccessFields.svelte';
  import RightsAffirmation from '$lib/components/monetization/RightsAffirmation.svelte';
  import type { PaidAccessContext } from '$lib/monetization/paid-access-form';
  import { resolveGateEligibility } from '$lib/monetization/gate-eligibility';
  import {
    MIN_ACCESS_PRICE,
    DEFAULT_GENERATION_TRIAL_LIMIT,
    GENERATION_ONLY_HINT,
    monetizationLimits,
    type CreatorUsageControl,
  } from '$lib/monetization/paid-access';

  import type { CreatorModelVersion } from '$lib/server/models';
  import type { CreatorCaps } from '$lib/server/membership';

  // The per-version paid-access editor (timed Early Access + permanent Paid Access) rendered inside the
  // licensing drawer. Owns the editable pricing state (`ea`) and every gating decision derived from the
  // version + the creator's caps/score. Remounted per version by the parent (`{#key version.id}`).
  let {
    version,
    onClose,
    caps,
  }: {
    version: CreatorModelVersion;
    onClose: () => void;
    caps: CreatorCaps;
  } = $props();

  const pricingLimit = $derived(caps.pricingLimit);
  const pricingUsed = $derived(caps.pricingUsed);
  const earlyAccessUsed = $derived(caps.earlyAccessUsed);
  const earlyAccessCap = $derived(caps.earlyAccessCap);
  const maxEarlyAccessDays = $derived(caps.maxEarlyAccessDays);
  const tier = $derived(caps.tier);
  // A version that already carries a price is exempt — only a NEW price spends allowance, so an edit
  // must never be blocked by a full month. A TIMED window is not a price: it prices itself out when the
  // window closes, so it must not count as one here.
  const alreadyPriced = $derived(
    isAlreadyPriced({
      licensingFee: version.licensingFee,
      hasPermanentGate: !!version.paidAccessConfig?.permanent,
    })
  );
  const allowance = $derived(
    pricingAllowanceState({ used: pricingUsed, limit: pricingLimit, exempt: alreadyPriced })
  );
  const permAtCap = $derived(allowance.atLimit);

  // Ever actually published — a Scheduled version's future anchor doesn't count, and an unpublished
  // version that once went live does. Seeding and eligibility must agree on this or the drawer can open
  // with a disabled card selected.
  const everPublished = $derived(
    (!!version.initialPublishedAt && version.initialPublishedAt <= new Date()) ||
      version.status === 'Published'
  );

  function seed(v: CreatorModelVersion) {
    const c = v.paidAccessConfig;
    // Timed early access can't be started on a published version or without score — default new gates to
    // permanent when only that's available. Clamp a seeded duration to the score-based max.
    const timedNewOk =
      maxEarlyAccessDays > 0 &&
      !((!!v.initialPublishedAt && v.initialPublishedAt <= new Date()) || v.status === 'Published');
    return {
      timeframe: Math.min(c?.timeframe ?? 7, maxEarlyAccessDays || Infinity),
      permanent: c?.permanent ?? !timedNewOk,
      accessPrice: (c?.accessPrice ?? MIN_ACCESS_PRICE) as number | undefined,
      generationPrice: c?.generationPrice as number | undefined,
      freePreviewGenerations: (c?.freePreviewGenerations ?? DEFAULT_GENERATION_TRIAL_LIMIT) as
        number | undefined,
      donationGoalEnabled: c?.donationGoalEnabled ?? false,
      donationGoal: c?.donationGoal as number | undefined,
      acceptsBlueBuzz: c?.acceptsBlueBuzz ?? false,
    };
  }
  // Seed once from the version at mount (the parent remounts via `{#key version.id}` on open).
  let ea = $state(untrack(() => seed(version)));
  let rightsAffirmed = $state(false);
  // Mirrors the save action's turnOff rule: a timed gate with no duration clears the gate rather than
  // selling anything, so it must not demand an affirmation to switch monetization OFF.
  const willTurnOff = $derived(!ea.permanent && !((ea.timeframe ?? 0) > 0));
  const mustAffirm = $derived(!version.rightsAffirmed && !willTurnOff && (ea.accessPrice ?? 0) > 0);

  // The three generation grants, in the order the terms model supports them: bundled (no price — falls back
  // to the access price), a cheaper separate price, or free for everyone. Only `separate` renders the price
  // input, so the other two never submit `generationPrice`. Seeded from the stored grant so an existing
  // choice survives an unrelated edit.
  let genMode = $state<'bundled' | 'separate' | 'free'>(
    untrack(() =>
      version.paidAccessConfig?.freeGeneration
        ? 'free'
        : version.paidAccessConfig?.generationPrice != null
          ? 'separate'
          : 'bundled'
    )
  );

  // A donation goal is create-once (the endpoint never updates or removes it), so once a version has one
  // the amount is locked here — reflected, not editable. Timed access only; permanent has none.
  const hadDonationGoal = $derived(!!version.paidAccessConfig?.donationGoalEnabled);
  // The permanent option stays available to an already-permanent version even if membership lapsed or the
  // tier is at capacity, so an edit can't strand the creator (mirrors the main-app carve-out).
  const alreadyPermanent = $derived(!!version.paidAccessConfig?.permanent);
  const canChoosePermanent = $derived(alreadyPermanent || !permAtCap);
  const permBlocked = $derived(permAtCap && !alreadyPermanent);
  // A version already on a timed gate stays editable regardless of score/publish state.
  const timedAlreadySet = $derived(!!version.paidAccessConfig && !alreadyPermanent);
  // Same rule the bulk dialog applies, over a selection of one — a published version is simply a
  // selection where nothing is eligible. The already-set carve-out is this editor's alone: it keeps an
  // existing window editable, which has no bulk equivalent.
  const eligibility = $derived(
    resolveGateEligibility({
      selectedCount: 1,
      // Ever published, not currently published — an unpublished version that once went live still can't
      // take an early-access window. publishedAt is no good here: the republish job overwrites it.
      publishedCount: everPublished ? 1 : 0,
      maxEarlyAccessDays,
      pricingSlotsLeft: canChoosePermanent ? 1 : 0,
      resolving: false,
    })
  );
  const canChooseTimed = $derived(timedAlreadySet || eligibility.canChooseTimed);
  const tierLabel = $derived(tier ? tier[0].toUpperCase() + tier.slice(1) : '');

  const paidAccessCtx = $derived<PaidAccessContext>({
    canChooseTimed,
    canChoosePermanent,
    permBlocked,
    timedBlockedReason: canChooseTimed ? undefined : eligibility.timedBlockedReason,
    maxEarlyAccessDays,
    pricingUsed,
    pricingLimit,
    earlyAccessUsed,
    earlyAccessCap,
    tierLabel,
    capTier: caps.capTier,

    hadDonationGoal,
  });
  // Usage control gates paid access: Download (download + gen) and Generation (on-site gen only, no
  // download charge) can be gated; other controls can't. Undefined defaults to Download.
  // The STORED control decides whether this version is editable here at all: the two API-only modes are
  // moderator territory, so we show a banner rather than a picker that would silently downgrade them.
  const paidAccessUsageOk = $derived(
    !version.usageControl ||
      version.usageControl === 'Download' ||
      version.usageControl === 'Generation'
  );
  // Editable (remounted per version by the parent's {#key}), so the pricing fields re-shape as soon as the
  // creator switches — a gen-only version has no download tier to charge for.
  // Captured once: the parent remounts this component per version ({#key version.id}), so the stored
  // value can't change underneath us. Drives both the dirty check and Cancel.
  const storedUsageControl: CreatorUsageControl = untrack(() =>
    version.usageControl === 'Generation' ? 'Generation' : 'Download'
  );
  let usageControl = $state<CreatorUsageControl>(storedUsageControl);
  const isGenOnly = $derived(usageControl === 'Generation');

  const usageEnhance =
    () => async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await event.update({ reset: false });
      if (event.result.type === 'success') {
        toast.success('Usage control saved');
        await invalidateAll();
      } else if (event.result.type === 'failure') {
        usageControl = storedUsageControl;
        toast.error(String(event.result.data?.error ?? 'Failed to save usage control'));
      }
    };

  const eaEnhance =
    () => async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await event.update({ reset: false });
      if (event.result.type === 'success') {
        toast.success(
          event.result.data?.paidAccessCleared ? 'Early access turned off' : 'Early access saved'
        );
        onClose();
        await invalidateAll();
      } else if (event.result.type === 'failure') {
        toast.error(String(event.result.data?.error ?? 'Failed to save early access'));
      }
    };
</script>

{#if paidAccessUsageOk}
  <section class="flex flex-col gap-4 border-t border-dark-4 pt-6">
    <div class="flex flex-col gap-1">
      <span class="text-sm font-medium text-white">How this version can be used</span>
      <span class="text-xs text-dark-2">
        Whether buyers get the files, or on-site generation only.
      </span>
    </div>
    <form method="POST" action="?/setUsageControl" use:enhance={usageEnhance}>
      <input type="hidden" name="versionId" value={version.id} />
      <UsageControlPicker
        bind:value={usageControl}
        allowGenerationOnly={caps.canSetGenerationOnly}
      />
      {#if !caps.canSetGenerationOnly}
        <p class="mt-2 text-xs text-dark-2">{GENERATION_ONLY_HINT}</p>
      {/if}
      {#if usageControl !== storedUsageControl}
        <div class="mt-3 flex items-center gap-3">
          <Button type="submit" size="sm">Save usage control</Button>
          <button
            type="button"
            class="text-xs text-dark-2 hover:text-white"
            onclick={() => (usageControl = storedUsageControl)}>Cancel</button
          >
        </div>
      {/if}
    </form>
  </section>
{/if}

<section class="flex flex-col gap-4 border-t border-dark-4 pt-6">
  <div class="flex flex-col gap-1">
    <span class="text-sm font-medium text-white">Early &amp; paid access</span>
    <span class="text-xs text-dark-2">
      Gate this version behind payment — for a limited time, or permanently.
    </span>
  </div>

  {#if !paidAccessUsageOk}
    <p class="rounded-lg border border-dark-4 p-3 text-xs text-dark-2">
      Paid access isn't available for this version — it's set to API-only generation, not download
      or on-site generation.
    </p>
  {:else if !canChooseTimed && !canChoosePermanent && !version.paidAccessConfig}
    <p class="rounded-lg border border-dark-4 p-3 text-xs text-dark-2">
      {#if version.status === 'Published'}
        Early access can't be started after a version is published, and you've used this month's
        pricing allowance ({formatPricingAllowance(allowance)}).
      {:else}
        Early access isn't available for your account yet — it unlocks as your creator score grows.
        You've also used this month's pricing allowance ({formatPricingAllowance(allowance)}).
      {/if}
    </p>
  {:else}
    <form
      method="POST"
      action="?/setPaidAccess"
      use:enhance={eaEnhance}
      class="flex flex-col gap-4"
    >
      <input type="hidden" name="versionId" value={version.id} />
      <input type="hidden" name="usageControl" value={usageControl} />

      <PaidAccessFields bind:ea bind:genMode {isGenOnly} ctx={paidAccessCtx} />
      {#if mustAffirm}
        <RightsAffirmation bind:checked={rightsAffirmed} />
      {/if}

      <SheetFooter class="flex-col gap-2 p-0">
        <Button type="submit" disabled={mustAffirm && !rightsAffirmed}>
          {ea.permanent ? 'Save paid access' : 'Save early access'}
        </Button>
        {#if version.paidAccessConfig}
          <Button type="submit" name="clear" value="true" variant="outline">
            {ea.permanent ? 'Turn off paid access' : 'Turn off early access'}
          </Button>
        {/if}
      </SheetFooter>
    </form>
  {/if}
</section>
