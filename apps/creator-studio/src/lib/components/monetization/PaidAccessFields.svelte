<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import CapUpsell from '$lib/components/CapUpsell.svelte';
  import {
    MIN_ACCESS_PRICE,
    MIN_GENERATION_PRICE,
    MAX_GENERATION_TRIAL_LIMIT,
  } from '$lib/monetization/paid-access';
  import type { CapTier } from '@civitai/buzz';
  import type { PaidAccessFormValue, PaidAccessContext } from '$lib/monetization/paid-access-form';

  // The timed-vs-permanent gate form, shared by the per-version sidebar and the bulk dialog.
  let {
    ea = $bindable(),
    genMode = $bindable(),
    isGenOnly,
    ctx,
    gateNotice,
  }: {
    ea: PaidAccessFormValue;
    genMode: 'bundled' | 'separate' | 'free';
    isGenOnly: boolean;
    ctx: PaidAccessContext;
    gateNotice?: Snippet;
  } = $props();

  const priceCap = $derived(ctx.accessCapFor(ctx.capTier, ea.permanent));
  const accessMax = $derived(
    priceCap == null ? undefined : Math.max(priceCap, ctx.storedAccessPrice)
  );
  const overCap = $derived(priceCap != null && (ea.accessPrice ?? 0) > priceCap);
  // The generation-only tier can't exceed the access price, and neither may exceed the tier's ceiling.
  const genPriceMax = $derived(
    accessMax == null ? ea.accessPrice : Math.min(ea.accessPrice ?? accessMax, accessMax)
  );
</script>

<input type="hidden" name="permanent" value={ea.permanent ? 'true' : 'false'} />
<div class="flex flex-col gap-2">
  <div class="grid grid-cols-2 gap-2">
    <button
      type="button"
      disabled={!ctx.canChooseTimed}
      onclick={() => ctx.canChooseTimed && (ea.permanent = false)}
      class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors {!ea.permanent
        ? 'border-blue-4 bg-blue-4/10'
        : 'border-dark-4 hover:border-dark-3'} {!ctx.canChooseTimed
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
      disabled={!ctx.canChoosePermanent}
      onclick={() => ctx.canChoosePermanent && (ea.permanent = true)}
      class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors {ea.permanent
        ? 'border-[#9775fa] bg-[#9775fa]/10'
        : 'border-dark-4 hover:border-dark-3'} {!ctx.canChoosePermanent
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
  {#if ctx.timedBlockedReason}
    <span class="text-xs text-dark-2">{ctx.timedBlockedReason}</span>
  {/if}
  {#if !ctx.canChoosePermanent}
    <span class="text-xs text-dark-2">
      You've reached your permanent paid-access limit ({ctx.permanentUsed} of {ctx.permanentCap}) —
      upgrade your membership for more.
    </span>
  {/if}
  {#if !ea.permanent && gateNotice}
    {@render gateNotice()}
  {/if}
</div>

{#if ea.permanent}
  <input type="hidden" name="timeframe" value="0" />
  <div class="text-xs {ctx.permBlocked ? 'text-yellow-5' : 'text-dark-2'}">
    {#if ctx.permanentCap === null}
      Paid access {ctx.permanentUsed} set · unlimited{ctx.tierLabel
        ? ` · ${ctx.tierLabel} tier`
        : ''}
    {:else}
      Paid access {ctx.permanentUsed} of {ctx.permanentCap} used{ctx.tierLabel
        ? ` · ${ctx.tierLabel} tier`
        : ''}{ctx.permBlocked ? ' — limit reached' : ''}
    {/if}
  </div>
{:else}
  <label class="flex flex-col gap-1 text-sm">
    <span class="text-dark-1">Early access duration (days)</span>
    <NumberInput
      name="timeframe"
      min={0}
      max={ctx.maxEarlyAccessDays}
      bind:value={ea.timeframe}
      class="w-32"
    />
    <span class="text-xs text-dark-2">
      Up to {ctx.maxEarlyAccessDays} day{ctx.maxEarlyAccessDays === 1 ? '' : 's'} at your creator level
      — set 0 to turn early access off.
    </span>
  </label>
  <div class="text-xs text-dark-2">
    Early access {ctx.earlyAccessUsed} of {ctx.earlyAccessCap} active · up to {ctx.maxEarlyAccessDays}
    day{ctx.maxEarlyAccessDays === 1 ? '' : 's'}
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
        capTier={ctx.capTier}
        capFor={(t: CapTier) => ctx.accessCapFor(t, ea.permanent) ?? Infinity}
        title="Price for access"
      />
    </div>
    {#if overCap}
      <span class="text-xs text-yellow-5">
        This price is above your membership's cap. You can keep or lower it, but not raise it —
        upgrade to charge more.
      </span>
    {/if}
  </label>
  {#if !isGenOnly}
    <div class="flex flex-col gap-2">
      <span class="text-sm text-dark-1">Generating on-site</span>
      <input type="hidden" name="freeGeneration" value={genMode === 'free' ? 'true' : 'false'} />
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
            What buyers pay to generate on-site without unlocking the download. Can't exceed the
            access price.
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
        disabled={ctx.hadDonationGoal}
      />
      <Label for="ea-dg" class="cursor-pointer text-sm font-normal text-white">
        Let the community unlock this early
      </Label>
    </div>
    <span class="text-xs text-dark-2">
      If the goal is met before the window ends, early access ends and the version becomes free for
      everyone.
    </span>
    {#if ea.donationGoalEnabled}
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-dark-2">Goal amount (⚡)</span>
        <NumberInput
          name="donationGoal"
          min={0}
          bind:value={ea.donationGoal}
          disabled={ctx.hadDonationGoal}
          class="w-40"
        />
      </label>
      {#if ctx.hadDonationGoal}
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
