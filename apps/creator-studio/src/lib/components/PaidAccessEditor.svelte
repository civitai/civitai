<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';
  import { SheetFooter } from '@civitai/ui/components/ui/sheet/index.js';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import CapUpsell from '$lib/components/CapUpsell.svelte';
  import {
    MIN_ACCESS_PRICE,
    MIN_GENERATION_PRICE,
    MAX_GENERATION_TRIAL_LIMIT,
    DEFAULT_GENERATION_TRIAL_LIMIT,
    monetizationLimits,
    CREATOR_USAGE_CONTROLS,
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

  const permanentCap = $derived(caps.permanentCap);
  const permanentUsed = $derived(caps.permanentUsed);
  const earlyAccessUsed = $derived(caps.earlyAccessUsed);
  const earlyAccessCap = $derived(caps.earlyAccessCap);
  const maxEarlyAccessDays = $derived(caps.maxEarlyAccessDays);
  const tier = $derived(caps.tier);
  const permAtCap = $derived(
    permanentCap !== null && permanentCap > 0 && permanentUsed >= permanentCap
  );

  function seed(v: CreatorModelVersion) {
    const c = v.paidAccessConfig;
    // Timed early access can't be started on a published version or without score — default new gates to
    // permanent when only that's available. Clamp a seeded duration to the score-based max.
    const timedNewOk = maxEarlyAccessDays > 0 && v.status !== 'Published';
    return {
      timeframe: Math.min(c?.timeframe ?? 7, maxEarlyAccessDays || Infinity),
      permanent: c?.permanent ?? !timedNewOk,
      accessPrice: (c?.accessPrice ?? MIN_ACCESS_PRICE) as number | undefined,
      generationPrice: c?.generationPrice as number | undefined,
      freePreviewGenerations: (c?.freePreviewGenerations ?? DEFAULT_GENERATION_TRIAL_LIMIT) as
        number | undefined,
      donationGoalEnabled: c?.donationGoalEnabled ?? false,
      donationGoal: c?.donationGoal as number | undefined,
    };
  }
  // Seed once from the version at mount (the parent remounts via `{#key version.id}` on open).
  let ea = $state(untrack(() => seed(version)));

  // Resolved per version AND per gate kind: a page-level cap can't know this version's media type, and a
  // timed early-access window has no price ceiling at all — only a permanent gate does.
  const limits = $derived(
    monetizationLimits({
      tier: caps.capTier,
      baseModel: version.baseModel,
      permanent: ea.permanent,
    })
  );
  const priceCap = $derived(limits.access.maxPrice);

  // max never drops below the stored price: the server blocks only RAISES, so clamping down would silently
  // cut a grandfathered price on any unrelated edit.
  const storedAccess = $derived(version.paidAccessConfig?.accessPrice ?? 0);
  const accessMax = $derived(priceCap == null ? undefined : Math.max(priceCap, storedAccess));
  const overCap = $derived(priceCap != null && (ea.accessPrice ?? 0) > priceCap);
  // The generation-only tier can't exceed the access price, and neither may exceed the tier's ceiling.
  const genPriceMax = $derived(
    accessMax == null ? ea.accessPrice : Math.min(ea.accessPrice ?? accessMax, accessMax)
  );

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
  // Timed early access can't be *started* on a published version (nor without score); permanent still can.
  const canChooseTimed = $derived(
    timedAlreadySet || (maxEarlyAccessDays > 0 && version.status !== 'Published')
  );
  const tierLabel = $derived(tier ? tier[0].toUpperCase() + tier.slice(1) : '');
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
      <input type="hidden" name="usageControl" value={usageControl} />
      <div class="grid grid-cols-2 gap-2">
        {#each CREATOR_USAGE_CONTROLS as opt (opt.value)}
          <button
            type="button"
            onclick={() => (usageControl = opt.value)}
            class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors {usageControl ===
            opt.value
              ? 'border-blue-4 bg-blue-4/10'
              : 'border-dark-4 hover:border-dark-3'}"
          >
            <span class="text-sm font-semibold text-white">{opt.label}</span>
            <span class="text-xs text-dark-2">{opt.hint}</span>
          </button>
        {/each}
      </div>
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
        Early access can't be started after a version is published, and you've reached your
        permanent paid-access limit ({permanentUsed} of {permanentCap}).
      {:else}
        Early access isn't available for your account yet — it unlocks as your creator score grows.
        You've also reached your permanent paid-access limit ({permanentUsed} of {permanentCap}).
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
            <span
              class="w-fit rounded-full bg-blue-4/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-3"
              >Timed</span
            >
            <span class="text-sm font-semibold text-white">Early Access</span>
            <span class="text-xs text-dark-2">Becomes free when the window ends.</span>
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
            <span
              class="w-fit rounded-full bg-[#9775fa]/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#d0bfff]"
              >Permanent</span
            >
            <span class="text-sm font-semibold text-white">Paid Access</span>
            <span class="text-xs text-dark-2">Always requires purchase.</span>
          </button>
        </div>
        {#if !canChooseTimed && version.status === 'Published'}
          <span class="text-xs text-dark-2">
            Early access can't be started after a version is published — use permanent paid access
            instead.
          </span>
        {/if}
        {#if !canChoosePermanent}
          <span class="text-xs text-dark-2">
            You've reached your permanent paid-access limit ({permanentUsed} of {permanentCap}) —
            upgrade your membership for more.
          </span>
        {/if}
      </div>

      {#if ea.permanent}
        <input type="hidden" name="timeframe" value="0" />
        <div class="text-xs {permBlocked ? 'text-yellow-5' : 'text-dark-2'}">
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
          <NumberInput
            name="timeframe"
            min={0}
            max={maxEarlyAccessDays}
            bind:value={ea.timeframe}
            class="w-32"
          />
          <span class="text-xs text-dark-2">
            Up to {maxEarlyAccessDays} day{maxEarlyAccessDays === 1 ? '' : 's'} at your creator level
            — set 0 to turn early access off.
          </span>
        </label>
        <div class="text-xs text-dark-2">
          Early access {earlyAccessUsed} of {earlyAccessCap} active · up to {maxEarlyAccessDays} day{maxEarlyAccessDays ===
          1
            ? ''
            : 's'}
        </div>
      {/if}

      <div class="flex flex-col gap-3 rounded-lg border border-dark-4 p-3">
        <span class="text-sm font-semibold text-white">Pricing</span>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-dark-1">Price for access <span class="text-red-6">*</span></span>
          <NumberInput
            name="accessPrice"
            min={MIN_ACCESS_PRICE}
            max={accessMax}
            bind:value={ea.accessPrice}
            class="w-40"
          />
          <span class="text-xs text-dark-2">
            {isGenOnly
              ? 'What buyers pay to generate with this version on-site.'
              : 'Buyers unlock download + generation.'}{#if priceCap != null}
              Your membership allows up to {priceCap.toLocaleString()} ⚡.
            {/if}
          </span>
          <div>
            <CapUpsell
              value={ea.accessPrice}
              cap={priceCap ?? Infinity}
              capTier={caps.capTier}
              capFor={(t) =>
                monetizationLimits({
                  tier: t,
                  baseModel: version.baseModel,
                  permanent: ea.permanent,
                }).access.maxPrice ?? Infinity}
              title="Price for access"
            />
          </div>
          {#if overCap}
            <span class="text-xs text-yellow-5">
              This price is above your membership's cap. You can keep or lower it, but not raise it
              — upgrade to charge more.
            </span>
          {/if}
        </label>
        {#if !isGenOnly}
          <div class="flex flex-col gap-2">
            <span class="text-sm text-dark-1">Generating on-site</span>
            <input
              type="hidden"
              name="freeGeneration"
              value={genMode === 'free' ? 'true' : 'false'}
            />
            <RadioGroup bind:value={genMode} class="flex flex-col gap-1.5">
              <div class="flex items-center gap-2">
                <RadioGroupItem value="bundled" id="ea-gen-bundled" />
                <Label for="ea-gen-bundled" class="cursor-pointer text-sm font-normal text-white">
                  Same as the access price
                </Label>
              </div>
              <div class="flex items-center gap-2">
                <RadioGroupItem value="separate" id="ea-gen-separate" />
                <Label for="ea-gen-separate" class="cursor-pointer text-sm font-normal text-white">
                  A cheaper generation-only price
                </Label>
              </div>
              <div class="flex items-center gap-2">
                <RadioGroupItem value="free" id="ea-gen-free" />
                <Label for="ea-gen-free" class="cursor-pointer text-sm font-normal text-white">
                  Free for everyone
                </Label>
              </div>
            </RadioGroup>
            {#if genMode === 'free'}
              <span class="text-xs text-dark-2">
                Anyone can generate on-site without buying; only the download is gated. Earn per
                generation with a licensing fee instead.
              </span>
            {:else if genMode === 'separate'}
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-dark-1">Generation-only price</span>
                <NumberInput
                  name="generationPrice"
                  min={MIN_GENERATION_PRICE}
                  max={genPriceMax}
                  bind:value={ea.generationPrice}
                  class="w-40"
                />
                <span class="text-xs text-dark-2">
                  What buyers pay to generate on-site without unlocking the download. Can't exceed
                  the access price.
                </span>
              </label>
            {/if}
          </div>
        {/if}
        <!-- A free grant has no trial to run out, so there's nothing to sample toward. Unmounted rather
             than hidden: the field preprocesses absent → 0, so it doesn't need to submit. -->
        {#if !(genMode === 'free' && !isGenOnly)}
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
            <span class="text-xs text-dark-2">
              Free test generations before purchase is required — clear or set 0 for none.
            </span>
          </label>
        {/if}
      </div>

      {#if !ea.permanent}
        <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
          <div class="flex items-center gap-2">
            <Checkbox
              id="ea-dg"
              name="donationGoalEnabled"
              bind:checked={ea.donationGoalEnabled}
              disabled={hadDonationGoal}
            />
            <Label for="ea-dg" class="cursor-pointer text-sm font-normal text-white">
              Let the community unlock this early
            </Label>
          </div>
          <span class="text-xs text-dark-2">
            If the goal is met before the window ends, early access ends and the version becomes
            free for everyone.
          </span>
          {#if ea.donationGoalEnabled}
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-dark-2">Goal amount (⚡)</span>
              <NumberInput
                name="donationGoal"
                min={0}
                bind:value={ea.donationGoal}
                disabled={hadDonationGoal}
                class="w-40"
              />
            </label>
            {#if hadDonationGoal}
              <span class="text-xs text-dark-2">
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
        <p class="text-xs text-dark-2">A duration of 0 turns early access off when you save.</p>
      {/if}

      <SheetFooter class="flex-col gap-2 p-0">
        <Button type="submit">{ea.permanent ? 'Save paid access' : 'Save early access'}</Button>
        {#if version.paidAccessConfig}
          <Button type="submit" name="clear" value="true" variant="outline">
            {ea.permanent ? 'Turn off paid access' : 'Turn off early access'}
          </Button>
        {/if}
      </SheetFooter>
    </form>
  {/if}
</section>
