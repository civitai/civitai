<script lang="ts">
  import { browser } from '$app/environment';
  import { untrack } from 'svelte';
  import { enhance, deserialize } from '$app/forms';
  import GenerationOnlyHint from '$lib/components/monetization/GenerationOnlyHint.svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import * as Alert from '@civitai/ui/components/ui/alert/index.js';
  import { Spinner } from '@civitai/ui/components/ui/spinner/index.js';
  import { IconAlertTriangle } from '@tabler/icons-svelte';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { invalidateAll } from '$app/navigation';
  import {
    DEFAULT_FEE_IMAGES,
    suggestedFeeRatio,
    type MonetizationLimits,
  } from '$lib/monetization/fee';
  import {
    DEFAULT_GENERATION_TRIAL_LIMIT,
    MIN_ACCESS_PRICE,
    type CreatorUsageControl,
  } from '$lib/monetization/paid-access';
  import UsageControlPicker from '$lib/components/monetization/UsageControlPicker.svelte';
  import LicensingFeeFields from '$lib/components/monetization/LicensingFeeFields.svelte';
  import PaidAccessFields from '$lib/components/monetization/PaidAccessFields.svelte';
  import RightsAffirmation from '$lib/components/monetization/RightsAffirmation.svelte';
  import type { PaidAccessContext, PaidAccessFormValue } from '$lib/monetization/paid-access-form';
  import { resolveGateEligibility } from '$lib/monetization/gate-eligibility';
  import type { CapTier, PricingEligibility } from '@civitai/buzz';
  import {
    BULK_ACTION_FORM,
    BULK_ACTION_TITLE,
    DESTRUCTIVE_ACTIONS,
    type BulkAction,
  } from '$lib/monetization/bulk-actions';

  let {
    action = $bindable(),
    versionIds,
    limits,
    suggestedFee,
    needsAffirmation,
    pricingSlotsLeft,
    pricingSlotsRemaining,
    capTier,
    caps,
    feeCapsByType,
  }: {
    action: BulkAction | null;
    versionIds: number[];
    limits: MonetizationLimits;
    suggestedFee: number | undefined;
    needsAffirmation: boolean;
    /**
     * An eligibility PREDICATE, not a count — valid only as `> 0`, and inflated by the selection's
     * already-priced versions so re-pricing them stays allowed. Use pricingSlotsRemaining for arithmetic.
     */
    pricingSlotsLeft: number;
    /** Slots the owner has left this month before this selection: limit - used. */
    pricingSlotsRemaining: number;
    capTier: CapTier;

    /** Per model/media type caps across the selection, lowest first. */
    feeCapsByType: { label: string; cap: number }[];
    caps: {
      tier: string;
      pricingFloor: PricingEligibility;
      pricingUsed: number;
      pricingLimit: number | null;
      maxEarlyAccessDays: number;
      earlyAccessUsed: number;
      earlyAccessCap: number;
      canSetGenerationOnly: boolean;
    };
  } = $props();

  const count = $derived(versionIds.length);
  const destructive = $derived(!!action && DESTRUCTIVE_ACTIONS.includes(action));
  const affirmable = $derived(action === 'fee' || action === 'paidAccess');

  let buzz = $state<number | undefined>();
  let images = $state(String(DEFAULT_FEE_IMAGES));
  // The suggestion comes from the type FILTER while the caps come from the SELECTION, and the two can
  // disagree; the helper drops a suggestion this editor has no denominator for.
  const suggestedRatio = $derived(suggestedFeeRatio(suggestedFee, limits.fee.denominators));
  let usageControl = $state<CreatorUsageControl>('Download');
  // Seeded by the open effect below rather than here: reading a prop in a $state initializer captures
  // only its first value, and every open re-seeds anyway.
  let ea = $state<PaidAccessFormValue>({
    timeframe: 7,
    permanent: false,
    accessPrice: undefined,
    generationPrice: undefined,
    freePreviewGenerations: DEFAULT_GENERATION_TRIAL_LIMIT,
    acceptsBlueBuzz: false,
    donationGoalEnabled: false,
    donationGoal: undefined,
  });
  let genMode = $state<'bundled' | 'separate' | 'free'>('bundled');
  let affirmed = $state(false);
  let confirmText = $state('');
  let submitting = $state(false);
  let applied = $state<{
    kind: BulkAction;
    usage: CreatorUsageControl;
    updated: number;
    skipped: number;
    failed: number;
  } | null>(null);

  const open = $derived(action !== null || applied !== null);

  const suggestedNext = $derived(
    applied?.kind === 'usageControl' && applied.usage === 'Download'
      ? ({ action: 'paidAccess', label: 'Set download price' } as const)
      : null
  );
  const otherActions = $derived(
    (['fee', 'paidAccess', 'usageControl'] as const).filter(
      (a) => a !== applied?.kind && a !== suggestedNext?.action
    )
  );

  // The form and the receipt are mutually exclusive; every transition goes through one of these so no
  // call site can leave both set.
  function startAction(next: BulkAction) {
    applied = null;
    action = next;
  }
  function showReceipt(outcome: NonNullable<typeof applied>) {
    action = null;
    applied = outcome;
  }
  function closeDialog() {
    action = null;
    applied = null;
  }

  // Every open starts clean: a tick or a typed confirmation must never carry over from a previous run.
  // `action` is the ONLY dependency: the seeds read props that move while the dialog is open (a bulk
  // apply calls invalidateAll, which rebuilds `limits`), and re-running this mid-edit would wipe the
  // creator's typed amount and re-enable submit under an in-flight write.
  $effect(() => {
    if (!action) return;
    untrack(() => {
      affirmed = false;
      confirmText = '';
      submitting = false;
      buzz = undefined;
      images = String(suggestedRatio.images);
      usageControl = 'Download';
      genMode = 'bundled';
      ea = {
        timeframe: Math.min(7, caps.maxEarlyAccessDays || Infinity),
        // Permanent is the only choice that's legal for every version regardless of publish state, and
        // at open time the publish check hasn't run yet. Opening on Timed would mean seeding a gate the
        // selection may not be able to take.
        permanent: true,
        accessPrice: MIN_ACCESS_PRICE,
        generationPrice: undefined,
        freePreviewGenerations: DEFAULT_GENERATION_TRIAL_LIMIT,
        acceptsBlueBuzz: false,
        donationGoalEnabled: false,
        donationGoal: undefined,
      };
    });
  });

  // Both previews are resolved on the server: "select all matching" reaches versions this page never
  // loaded, so neither answer can be computed from what is on screen.
  //
  // Derived, never fetched into $state from an $effect. The selection changes while a request is in
  // flight — deselect a version, reopen on another action — and the assigning form let the older
  // response land on the newer selection, silently describing the wrong set of versions.
  async function preview<T>(formAction: string, ids: number[], read: (data: any) => T, empty: T) {
    const body = new FormData();
    body.set('versionIds', ids.join(','));
    const parsed = deserialize(await (await fetch(formAction, { method: 'POST', body })).text());
    return parsed.type === 'success' ? read(parsed.data) : empty;
  }

  type FreeGenAffected = { versionId: number; modelName: string; versionName: string }[];
  const freeGenPreview = $derived(
    browser && action === 'usageControl' && usageControl === 'Generation' && versionIds.length > 0
      ? preview<FreeGenAffected>(
          '?/freeGenerationPreview',
          versionIds,
          (d) => (d?.affected ?? []) as FreeGenAffected,
          []
        )
      : null
  );
  // Only the server knows which of a select-all are already priced — `alreadyPricedIds` on the page is
  // built from the loaded rows alone, so off-page versions read as new and inflate the count.
  const unpricedPreview = $derived(
    browser && (action === 'paidAccess' || action === 'fee') && versionIds.length > 0
      ? preview<number | null>(
          '?/unpricedPreview',
          versionIds,
          (d) => (d?.unpriced == null ? null : Number(d.unpriced)),
          null
        )
      : null
  );

  let unpricedCount = $state<number | null>(null);
  $effect(() => {
    const pending = unpricedPreview;
    if (!pending) {
      unpricedCount = null;
      return;
    }
    let current = true;
    pending
      .then((n) => {
        if (current) unpricedCount = n;
      })
      .catch(() => {
        if (current) unpricedCount = null;
      });
    return () => {
      current = false;
    };
  });

  const publishedPreview = $derived(
    browser && action === 'paidAccess' && versionIds.length > 0
      ? preview<number>('?/publishedPreview', versionIds, (d) => Number(d?.published ?? 0), 0)
      : null
  );

  // resolveGateEligibility needs a value, not a promise. It takes `resolving` so an unanswered preview
  // shows as "checking" rather than as zero-published, which would offer a timed window the server
  // refuses; the awaited value below replaces it the moment it lands.
  let publishedCount = $state(0);
  let loadingPublished = $state(true);
  $effect(() => {
    const pending = publishedPreview;
    if (!pending) {
      publishedCount = 0;
      loadingPublished = false;
      return;
    }
    loadingPublished = true;
    let current = true;
    pending
      .then((n) => {
        // Guarded: a response for a superseded selection must not overwrite the current one.
        if (current) publishedCount = n;
      })
      .catch(() => {
        if (current) publishedCount = 0;
      })
      .finally(() => {
        if (current) loadingPublished = false;
      });
    return () => {
      current = false;
    };
  });

  const eligibility = $derived(
    resolveGateEligibility({
      selectedCount: count,
      publishedCount,
      maxEarlyAccessDays: caps.maxEarlyAccessDays,
      pricingSlotsLeft,
      pricingFloor: caps.pricingFloor,
      // A bulk write only prices what is UNPRICED, so a selection with nothing unpriced spends no
      // allowance and faces no floor — which is how the server answers it too (unpricedVersionIds ->
      // assertPricingAllowed short-circuits). Null means the count has not arrived; assume it prices.
      alreadyPriced: unpricedCount === 0,
      resolving: loadingPublished,
    })
  );
  // The publish check is async, so the form can be sitting on Timed when the answer arrives. Correct it
  // rather than leaving the selected card disabled and the submit silently invalid.
  $effect(() => {
    if (action === 'paidAccess' && !ea.permanent && !eligibility.canChooseTimed)
      ea.permanent = true;
  });
  const bulkPaidAccessCtx = $derived<PaidAccessContext>({
    canChooseTimed: eligibility.canChooseTimed,
    canChoosePermanent: eligibility.canChoosePermanent,
    permBlocked: eligibility.permBlocked,
    timedBlockedReason: eligibility.timedBlockedReason,
    permBlockedReason: eligibility.permBlockedReason,
    maxEarlyAccessDays: caps.maxEarlyAccessDays,
    pricingUsed: caps.pricingUsed,
    pricingLimit: caps.pricingLimit,
    earlyAccessUsed: caps.earlyAccessUsed,
    earlyAccessCap: caps.earlyAccessCap,
    tierLabel: caps.tier ? caps.tier[0].toUpperCase() + caps.tier.slice(1) : '',
    capTier,
    hadDonationGoal: false,
  });

  const confirmWord = $derived(action === 'clearFee' ? 'clear' : 'remove');
  const confirmed = $derived(!destructive || confirmText.trim().toLowerCase() === confirmWord);
  const affirmationOk = $derived(!affirmable || !needsAffirmation || affirmed);
  const canApply = $derived(count > 0 && confirmed && affirmationOk && !submitting);

  // Both a fee and a permanent gate spend allowance, so both need the warning — the fee path is
  // all-or-nothing, so without it a 20-version selection just returns 403 with nothing on screen first.
  const overSlots = $derived(
    (action === 'paidAccess' || action === 'fee') &&
      ((unpricedCount !== null && unpricedCount > pricingSlotsRemaining) ||
        !!eligibility.permBlockedReason)
  );

  const submit = () => {
    // Captured before the await: the handler clears `action` on success, so reading it afterwards
    // would throw.
    const kind = action;
    const usage = usageControl;
    submitting = true;
    return async ({ result, update }: { result: any; update: () => Promise<void> }) => {
      submitting = false;
      if (result.type === 'success') {
        const d = result.data ?? {};
        // The dialog becomes its own receipt rather than closing onto a table the write just emptied —
        // and applying one operation is usually the setup for the next over the same versions, which a
        // close would make the creator rebuild from the bar.
        showReceipt({
          kind: kind ?? 'fee',
          usage,
          updated: Number(d.updated ?? d.cleared ?? d.removed ?? d.usageUpdated ?? 0),
          // The action only fails outright when NOTHING succeeded, so a run that skipped or failed most
          // of the selection still lands here and has to say so.
          skipped: Number(d.skippedPublished ?? 0),
          failed: Number(d.failed ?? 0),
        });
        // Selection is deliberately kept: a successful write is exactly what moves rows out of the
        // filter that found them.
        await invalidateAll();
      } else if (result.type === 'failure') {
        toast.error(String(result.data?.error ?? 'That did not work'));
      } else {
        await update();
      }
    };
  };
</script>

{#snippet publishedNotice()}
  {#if eligibility.timedPartialNotice}
    {@const n = eligibility.timedPartialNotice}
    <Alert.Root>
      <IconAlertTriangle />
      <Alert.Title>
        Applies to {n.applies} of {count} selected
      </Alert.Title>
      <Alert.Description>
        {n.skipped} have been published before, and early access can't be started after publishing — those
        will be left unchanged. Use permanent paid access to gate them.
      </Alert.Description>
    </Alert.Root>
  {/if}
{/snippet}

<Dialog.Root
  {open}
  onOpenChange={(v: boolean) => {
    // Not dismissable while a write is in flight: the request keeps going either way, and closing
    // leaves the creator with no indication that half their selection is still changing.
    if (!v && !submitting) {
      closeDialog();
    }
  }}
>
  <!-- No click-outside dismissal: these forms carry a whole selection's worth of pricing, and a stray
       click on the page behind would discard it (or, mid-write, hide an apply that's still running). -->
  <Dialog.Content class="max-w-lg" interactOutsideBehavior="ignore">
    {#if applied}
      <Dialog.Header>
        <Dialog.Title>{BULK_ACTION_TITLE[applied.kind]} applied</Dialog.Title>
        <Dialog.Description>
          {applied.updated} version{applied.updated === 1 ? '' : 's'} updated
        </Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-3 py-2">
        {#if applied.skipped > 0 || applied.failed > 0}
          <Alert.Root>
            <IconAlertTriangle />
            <Alert.Title>Not everything in your selection changed</Alert.Title>
            <Alert.Description>
              {#if applied.skipped > 0}
                <p>
                  {applied.skipped} had already been published, so an early-access window couldn't start
                  on {applied.skipped === 1 ? 'it' : 'them'}. Permanent paid access still can.
                </p>
              {/if}
              {#if applied.failed > 0}
                <p>
                  {applied.failed} couldn't be updated — usually a usage control that can't be gated.
                </p>
              {/if}
            </Alert.Description>
          </Alert.Root>
        {/if}

        <p class="text-xs text-dark-2">
          The same {count} version{count === 1 ? '' : 's'}
          {count === 1 ? 'is' : 'are'} still selected.
        </p>

        {#if suggestedNext}
          <div class="flex flex-col gap-1.5">
            <span class="text-[10px] font-medium uppercase tracking-wider text-dark-2">
              Next for these {count}
            </span>
            <Button class="w-full" onclick={() => startAction(suggestedNext.action)}>
              {suggestedNext.label} →
            </Button>
            <p class="text-xs text-dark-2">
              Versions with no download price fall back to their generation price until you set one.
            </p>
          </div>
        {/if}

        <div class="flex flex-col gap-1.5">
          <span class="text-[10px] font-medium uppercase tracking-wider text-dark-2">
            {suggestedNext ? 'Or apply something else' : `Next for these ${count}`}
          </span>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {#each otherActions as a (a)}
              <Button variant="outline" size="sm" class="w-full" onclick={() => startAction(a)}>
                {BULK_ACTION_TITLE[a]}
              </Button>
            {/each}
          </div>
        </div>
      </div>

      <Dialog.Footer class="flex-col gap-2 sm:flex-col">
        <!-- `secondary` is the same token as `muted`, which is the footer's own background — it renders
             indistinguishable from `ghost` here. Filled is the only variant that reads as a button. -->
        <Button class="w-full" onclick={closeDialog}>Done</Button>
      </Dialog.Footer>
    {:else if action}
      <Dialog.Header>
        <Dialog.Title class={destructive ? 'text-red-4' : ''}>
          {BULK_ACTION_TITLE[action]}
        </Dialog.Title>
        <Dialog.Description>
          {count} version{count === 1 ? '' : 's'}
        </Dialog.Description>
      </Dialog.Header>

      {#snippet allowanceAlert()}
        <Alert.Root variant="destructive">
          <IconAlertTriangle />
          {#if eligibility.permBlockedReason}
            <Alert.Title>You can't monetize a model version yet</Alert.Title>
            <Alert.Description>{eligibility.permBlockedReason}</Alert.Description>
          {:else}
            <Alert.Title>Over this month's monetization limit</Alert.Title>
            <Alert.Description>
              You can monetize {pricingSlotsRemaining} more model version{pricingSlotsRemaining ===
              1
                ? ''
                : 's'} this month, but this selection would monetize {unpricedCount}. Deselect some,
              or the save will be rejected. Versions you already monetize don't count.
            </Alert.Description>
          {/if}
        </Alert.Root>
      {/snippet}

      <form method="POST" action={BULK_ACTION_FORM[action]} use:enhance={submit} class="contents">
        <input type="hidden" name="versionIds" value={versionIds.join(',')} />

        <div class="flex flex-col gap-4 py-2">
          {#if action === 'fee'}
            <div class="flex flex-col gap-1.5">
              <Label>Fee</Label>
              <LicensingFeeFields
                bind:buzz
                bind:images
                {limits}
                suggested={suggestedRatio.buzz > 0 ? suggestedRatio : undefined}
              />
              {#if overSlots}
                {@render allowanceAlert()}
              {/if}
              {#if feeCapsByType.length > 1}
                <div class="rounded-lg border border-dark-4 p-2">
                  <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-dark-2">
                    Caps in this selection
                  </p>
                  <ul class="text-xs text-dark-1">
                    {#each feeCapsByType as c (c.label)}
                      <li class="flex justify-between gap-3">
                        <span>{c.label}</span>
                        <span class="tabular-nums">{c.cap} ⚡ / generation</span>
                      </li>
                    {/each}
                  </ul>
                  <p class="mt-1 text-xs text-dark-2">
                    One fee applies to all of them, so the lowest governs — the save is rejected if
                    it would raise any version past its own cap.
                  </p>
                </div>
              {:else}
                <p class="text-xs text-dark-2">Caps shown are the strictest in your selection.</p>
              {/if}
            </div>
          {:else if action === 'paidAccess'}
            <PaidAccessFields
              bind:ea
              bind:genMode
              isGenOnly={false}
              ctx={bulkPaidAccessCtx}
              gateNotice={publishedNotice}
            />
            {#if overSlots && ea.permanent}
              {@render allowanceAlert()}
            {/if}
          {:else if action === 'usageControl'}
            <UsageControlPicker
              bind:value={usageControl}
              allowGenerationOnly={caps.canSetGenerationOnly}
            />
            {#if !caps.canSetGenerationOnly}
              <GenerationOnlyHint />
            {/if}
            <p class="text-xs text-dark-2">
              A gated version's price moves to whichever tier survives — no version is left gated
              without a price.
            </p>
            {#if usageControl === 'Generation' && freeGenPreview}
              {#await freeGenPreview}
                <p class="text-xs text-dark-2">Checking for versions that give generation away…</p>
              {:then affected}
                {#if affected.length > 0}
                  <Alert.Root variant="destructive">
                    <IconAlertTriangle />
                    <Alert.Title>
                      {affected.length} version{affected.length === 1 ? '' : 's'} will stop giving generation
                      away
                    </Alert.Title>
                    <Alert.Description>
                      <p class="mb-2">
                        These charge for downloads and give generation away free. Generation-only
                        can't do both, so they'll start charging their download price to generate.
                      </p>
                      <ul class="max-h-32 overflow-y-auto text-xs">
                        {#each affected as v (v.versionId)}
                          <li class="truncate">{v.modelName} · {v.versionName}</li>
                        {/each}
                      </ul>
                    </Alert.Description>
                  </Alert.Root>
                {/if}
              {:catch}
                <p class="text-xs text-yellow-5">
                  Couldn't check which versions give generation away — they will still be switched.
                </p>
              {/await}
            {/if}
          {:else if action === 'clearFee'}
            <p class="text-sm text-dark-1">
              Removes the licensing fee from {count} version{count === 1 ? '' : 's'}. They stop
              earning per generation and go back to the creator-compensation pool.
            </p>
          {:else if action === 'removeAccess'}
            <Alert.Root variant="destructive">
              <IconAlertTriangle />
              <Alert.Title>Anyone who already bought access keeps it</Alert.Title>
              <Alert.Description>
                Removing the gate stops new sales — it doesn't revoke what people paid for.
              </Alert.Description>
            </Alert.Root>
          {/if}

          {#if affirmable && needsAffirmation}
            <RightsAffirmation
              bind:checked={affirmed}
              note="Recorded per version. Versions already affirmed are skipped."
            />
          {/if}

          {#if destructive}
            <div class="flex flex-col gap-1.5">
              <Label for="bulk-confirm">Type <code>{confirmWord}</code> to confirm</Label>
              <Input
                id="bulk-confirm"
                class="w-40"
                placeholder={confirmWord}
                autocomplete="off"
                bind:value={confirmText}
              />
              <p class="text-xs text-dark-2">
                There's no undo — export first if you want a record.
              </p>
            </div>
          {/if}
        </div>

        <Dialog.Footer class="sm:flex-wrap sm:items-center">
          {#if submitting}
            <span class="mr-auto flex items-center gap-2 text-xs text-dark-2">
              <Spinner class="size-3.5" />
              Applying to {count} version{count === 1 ? '' : 's'}…
            </span>
          {/if}
          <Button type="button" variant="ghost" disabled={submitting} onclick={closeDialog}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={destructive ? 'destructive' : 'default'}
            disabled={!canApply}
          >
            {#if submitting}
              <Spinner class="size-3.5" />
            {/if}
            {destructive ? 'Remove from' : 'Apply to'}
            {count}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
