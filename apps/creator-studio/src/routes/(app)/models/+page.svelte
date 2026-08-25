<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteSet } from 'svelte/reactivity';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import {
    Card,
    CardHeader,
    CardTitle,
    CardContent,
  } from '@civitai/ui/components/ui/card/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
  } from '@civitai/ui/components/ui/sheet/index.js';
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import * as Pagination from '@civitai/ui/components/ui/pagination/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import {
    feeToRatio,
    feeMaxFor,
    monetizationLimits,
    suggestedFee,
    seedFeeRatio,
    DEFAULT_FEE_IMAGES,
    type MonetizationLimits,
  } from '$lib/monetization/fee';
  import { capMediaType, type CapTier } from '@civitai/buzz';
  import JoinUpsell from '$lib/components/JoinUpsell.svelte';
  import TierCapsTable from '$lib/components/TierCapsTable.svelte';
  import LicensingFeeFields from '$lib/components/monetization/LicensingFeeFields.svelte';
  import RightsAffirmation from '$lib/components/monetization/RightsAffirmation.svelte';
  import PaidAccessEditor from '$lib/components/PaidAccessEditor.svelte';
  import BulkBar from '$lib/components/BulkBar.svelte';
  import BulkActionDialog from '$lib/components/BulkActionDialog.svelte';
  import type { BulkAction } from '$lib/monetization/bulk-actions';
  import { maxPaidAccessPrice } from '$lib/monetization/paid-access';

  // Gold's cap is Infinity; the context contract says uncapped is null.
  const finiteOrNull = (n: number) => (Number.isFinite(n) ? n : null);
  import {
    IconSearch,
    IconFilter,
    IconChevronLeft,
    IconChevronRight,
    IconExternalLink,
  } from '@tabler/icons-svelte';
  import { modelUrl } from '$lib/model-url';
  import type { PageData } from './$types';
  import type { ModelsView } from '$lib/server/models-view';
  import type { CreatorModel, CreatorModelVersion } from '$lib/server/models';

  let { data }: { data: PageData } = $props();

  // Filter-as-you-type swaps only the query-dependent slice (CU 868kv6ejd); the caps, scores and sale
  // windows beside it in `data` are per-creator and no search term can move them.
  let live = $state<ModelsView | null>(null);
  const view = $derived<ModelsView>(live ?? data);
  // A completed navigation or an invalidateAll is authoritative: drop the live slice so the two can
  // never disagree about what the URL is showing.
  $effect(() => {
    data;
    live = null;
  });

  // Arrived from Sales via "New sale": the page is here to collect a selection and hand it back.
  // Read from the view rather than the URL so the banner cannot be absent while the list is narrowed —
  // the server narrows on `for=sale` alone, and an unexplained short list is worse than an early prompt.
  const pickingForSale = $derived(view.query.saleOnly);

  // The tier every cap on this page resolves against (a lapse falls back to free, never to "no access").
  const tier = $derived(data.caps.capTier);

  // Off / Active / Over cap — anyone may set a fee now, so the amber state means "above your tier's ceiling
  // for this model type": still charged in full, but it can't be raised until the membership is upgraded.
  function feeStatus(
    fee: number | null,
    modelType: string,
    baseModel: string
  ): { label: string; cls: string } {
    if (fee == null || fee <= 0) return { label: 'Off', cls: 'text-dark-2' };
    return fee > monetizationLimits({ tier, modelType, baseModel }).fee.maxPerGeneration
      ? { label: 'Over cap', cls: 'text-yellow-5' }
      : { label: 'Active', cls: 'text-green-5' };
  }

  // Versions storing a fee above the creator's cap. They earn the capped amount, not the stored one, and
  // the per-row "Over cap" chip only reaches someone already scanning the table — the creator in
  // CU 868kn7zu4 set a fee before caps existed and had no reason to look again.
  const overCapVersions = $derived.by(() => {
    const out: { name: string; stored: number; effective: number }[] = [];
    for (const m of view.models)
      for (const v of m.versions) {
        const fee = v.licensingFee ?? 0;
        if (fee <= 0) continue;
        const cap = monetizationLimits({ tier, modelType: m.type, baseModel: v.baseModel }).fee
          .maxPerGeneration;
        if (fee > cap) out.push({ name: `${m.name} · ${v.name}`, stored: fee, effective: cap });
      }
    return out;
  });

  // Compact fee chip for a scan row: colour mirrors feeStatus (green Active / amber Capped / dim Off).
  function feeChip(
    fee: number | null,
    modelType: string,
    baseModel: string
  ): { label: string; cls: string } {
    if (fee == null || fee <= 0) return { label: 'Fee off', cls: 'border-dark-4 text-dark-2' };
    const { buzz, images } = feeToRatio(fee);
    const label = images === 1 ? `${buzz} ⚡ / gen` : `${buzz} ⚡ / ${images}`;
    return fee > monetizationLimits({ tier, modelType, baseModel }).fee.maxPerGeneration
      ? { label, cls: 'border-yellow-5/30 bg-yellow-5/10 text-yellow-5' }
      : { label, cls: 'border-green-5/30 bg-green-5/10 text-green-5' };
  }

  // Early-access chip: shown (green) only while a window is actually active, so it clearly means
  // "early access is on" and nothing else.
  const eaChipCls = 'border-green-5/30 bg-green-5/10 text-green-5';
  // Permanent (sold indefinitely) is a different product from a timed early-access window — distinct colour so
  // the two never read as the same thing.
  const permChipCls = 'border-blue-4/30 bg-blue-4/10 text-blue-3';

  // The access badge for a scan row — folds the Buzz access price into the label so the price is visible on
  // mobile without opening the drawer. accessPrice is undefined for a free grant, so the price is omitted then.
  function accessBadge(config: NonNullable<CreatorModelVersion['paidAccessConfig']>): {
    label: string;
    cls: string;
    title: string;
  } {
    const price = config.accessPrice ? ` · ${config.accessPrice.toLocaleString()} ⚡` : '';
    return config.permanent
      ? {
          label: `Permanent${price}`,
          cls: permChipCls,
          title: 'Sold indefinitely — paid access with no end date',
        }
      : {
          label: `Early access${price}`,
          cls: eaChipCls,
          title: 'Timed early access — becomes free when the window ends',
        };
  }
  // Permanent access is capped by CP tier (null cap = unlimited); concurrent early access by models score.
  const permAtCap = $derived(
    data.caps.permanentCap !== null &&
      data.caps.permanentCap > 0 &&
      data.caps.permanentUsed >= data.caps.permanentCap
  );
  const eaAtCap = $derived(
    data.caps.earlyAccessCap > 0 && data.caps.earlyAccessUsed >= data.caps.earlyAccessCap
  );

  // Version status as a distinct tag (M5) — green when Published, dim for Draft/other — so it reads as a badge
  // rather than blending into the base-model text.
  function statusBadgeCls(status: string): string {
    return status === 'Published'
      ? 'border-green-5/30 bg-green-5/10 text-green-5'
      : 'border-dark-4 bg-dark-6 text-dark-2';
  }

  // Filter popover options (M3). Empty status = the default "hide drafts" view.
  const statusOptions = [
    { value: '', label: 'Active (hide drafts)' },
    { value: 'published', label: 'Published only' },
    { value: 'draft', label: 'Drafts only' },
    { value: 'all', label: 'All statuses' },
  ];
  const feeOptions = [
    { value: '', label: 'All fees' },
    { value: 'set', label: 'Has a fee' },
    { value: 'off', label: 'No fee' },
  ];
  // Count only non-default filters (an empty status is the default, so it doesn't count).
  const activeFilterCount = $derived(
    (view.query.status ? 1 : 0) +
      (view.query.bm ? 1 : 0) +
      (view.query.mt ? 1 : 0) +
      (view.query.access ? 1 : 0) +
      (view.query.fee ? 1 : 0)
  );

  // --- URL-driven table state (search / fee filter / sort / pagination) ---
  function navigate(params: Record<string, string | null>) {
    goto(buildHref(params), { keepFocus: true, noScroll: true, replaceState: true });
  }

  // Build off the current URL, applying overrides — so links (bulk mode on/off) preserve the active
  // filters/sort/page instead of resetting them (868ke491x bulk-edit-clears-filters bug).
  function buildParams(overrides: Record<string, string | null>): URLSearchParams {
    const params = new URLSearchParams(page.url.searchParams);
    for (const [k, v] of Object.entries(overrides)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    return params;
  }

  function buildHref(overrides: Record<string, string | null>): string {
    const qs = buildParams(overrides).toString();
    return qs ? `${page.url.pathname}?${qs}` : page.url.pathname;
  }

  // --- Live search ---
  // Staged locally rather than mirrored from the view: a bulk action reloads the page, and binding the
  // input to server state would wipe a term the creator had typed but not yet settled.
  let draftTerm = $state<string | null>(null);
  const term = $derived(draftTerm ?? view.query.q);
  // Drop the draft only once the view AGREES with it. Clearing unconditionally discards characters typed
  // while a search is still in flight, and the pending timer then searches the reverted value.
  $effect(() => {
    if (draftTerm === view.query.q) draftTerm = null;
  });

  let searchTimer: ReturnType<typeof setTimeout>;
  let inFlight: AbortController | null = null;
  let searchSeq = 0;
  let searching = $state(false);
  // Both outlive this component: navigating away mid-type would otherwise fire a search against a page
  // the creator has left.
  $effect(() => () => {
    clearTimeout(searchTimer);
    inFlight?.abort();
  });

  // The whole point of the endpoint over a navigation: one query set per settled keystroke instead of
  // the entire load. The URL still gets the term — shallow, so `buildHref` (filters, paging, the CSV
  // link) reads it and a reload or a bulk action's invalidateAll lands on the same results.
  async function search(raw: string) {
    const q = raw.trim();
    if (q === view.query.q) return;
    const params = buildParams({ q: q || null, page: null });
    const qs = params.toString();
    replaceState(qs ? `${page.url.pathname}?${qs}` : page.url.pathname, page.state);

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const seq = ++searchSeq;
    searching = true;
    try {
      const res = await fetch(`/models/search?${qs}`, { signal: controller.signal });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as ModelsView;
      if (seq === searchSeq) live = next;
    } catch {
      if (controller.signal.aborted || seq !== searchSeq) return;
      // Leaving the previous results up under a term that no longer produced them reads as "no matches
      // for what you typed", which is a wrong answer rather than a failure. `invalidateAll` rather than
      // a goto: the URL already carries the term, and goto to the URL you are on does not re-run loads.
      toast.error('Search failed.');
      await invalidateAll();
    } finally {
      if (seq === searchSeq) searching = false;
    }
  }

  function typed(value: string) {
    draftTerm = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(value), 400);
  }

  // Enter and the button skip the wait; they don't do anything the debounce wouldn't.
  function submitSearch(e: SubmitEvent) {
    e.preventDefault();
    clearTimeout(searchTimer);
    search(term);
  }

  // --- Bulk selection ---
  // Always available: no mode to enter, so the bar and the checkboxes are visible to a creator who'd
  // never think to look for them. A reactive Set — in-place add/delete/clear stay fine-grained.
  const selected = new SvelteSet<number>();
  let bulkAction = $state<BulkAction | null>(null);
  // Permanent slots the creator can still fill (null cap = unlimited).
  const remainingPermanentSlots = $derived(
    data.caps.permanentCap === null
      ? Infinity
      : Math.max(0, data.caps.permanentCap - data.caps.permanentUsed)
  );
  // Versions already sold permanently don't consume a NEW slot when re-priced — mirrors the server's
  // countPermanentAccessVersionsExcluding baseline, so re-pricing stays possible even at the cap.
  const alreadyPermanentIds = $derived(
    new Set(
      view.models
        .flatMap((m) => m.versions)
        .filter((v) => v.paidAccessConfig?.permanent)
        .map((v) => v.id)
    )
  );
  // Slots the current selection would consume, for the paid-access form's over-cap warning.
  const newSlotsUsed = $derived.by(() => {
    let n = 0;
    for (const id of selected) if (!alreadyPermanentIds.has(id)) n++;
    return n;
  });
  const affirmedIds = $derived(
    new Set(
      view.models
        .flatMap((m) => m.versions)
        .filter((v) => v.rightsAffirmed)
        .map((v) => v.id)
    )
  );
  // A "select all" spans pages, so ids outside the current page aren't in `affirmedIds` — treat those as
  // needing an affirmation rather than assuming they have one. The server re-checks per version regardless.
  const selectionNeedsAffirmation = $derived.by(() => {
    for (const id of selected) if (!affirmedIds.has(id)) return true;
    return false;
  });
  const selectedIds = $derived([...selected]);
  const matchingIds = $derived(new Set(view.matchingVersionIds));
  // Selected versions the current filters no longer return — usually because a bulk write just moved
  // them out of the filter that found them. They stay selected and actionable; the bar names the count
  // so it never claims rows the table isn't showing.
  const offViewCount = $derived.by(() => {
    let n = 0;
    for (const id of selected) if (!matchingIds.has(id)) n++;
    return n;
  });
  const allMatchingSelected = $derived(
    view.matchingVersionIds.length > 0 && selected.size >= view.matchingVersionIds.length
  );
  // Suggested fee is per model type, so it's only unambiguous when the type filter pins one. It lives in
  // the fee form now rather than the bar — it's an input default, not an operation.
  const bulkSuggested = $derived(
    view.query.mt ? suggestedFee({ modelType: view.query.mt, baseModel: view.query.bm }) : undefined
  );

  // One fee is applied to every picked version, so the input is capped by the STRICTEST cap in the
  // selection — matching bulkSetLicensingFee on the server. "Select all" can pick versions beyond this
  // page, whose model types aren't loaded, so anything unresolved falls back to the non-checkpoint cap
  // (the strictest there is).
  // Parameterised by tier so the cap upsell can ask "what would Gold allow for this same selection?"
  function strictestLimits(t: CapTier): MonetizationLimits {
    const loaded = new Map<number, { modelType: string; baseModel: string }>();
    for (const m of view.models)
      for (const v of m.versions) loaded.set(v.id, { modelType: m.type, baseModel: v.baseModel });
    let strictest: MonetizationLimits | null = null;
    for (const id of selected) {
      const v = loaded.get(id);
      const limits = monetizationLimits({
        tier: t,
        modelType: v?.modelType,
        baseModel: v?.baseModel,
      });
      if (!strictest || limits.fee.maxPerGeneration < strictest.fee.maxPerGeneration)
        strictest = limits;
    }
    return strictest ?? monetizationLimits({ tier: t });
  }
  const bulkLimits = $derived(strictestLimits(tier));

  // One fee is applied across the whole selection, and the server rejects the batch if it would raise ANY
  // version past that version's own cap — so a single "your cap is N" hides which member is binding.
  // Grouped by the two axes that move the cap: model type and the media type of the base model.
  const selectionFeeCaps = $derived.by(() => {
    const byKey = new Map<string, { label: string; cap: number }>();
    for (const m of view.models)
      for (const v of m.versions) {
        if (!selected.has(v.id)) continue;
        const cap = monetizationLimits({ tier, modelType: m.type, baseModel: v.baseModel }).fee
          .maxPerGeneration;
        const media = capMediaType(v.baseModel);
        const key = `${m.type}|${media}`;
        if (!byKey.has(key))
          byKey.set(key, { label: media === 'video' ? `${m.type} (video)` : m.type, cap });
      }
    return [...byKey.values()].sort((a, b) => a.cap - b.cap);
  });

  function toggleVersion(id: number) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
  function selectedCount(model: CreatorModel) {
    let n = 0;
    for (const v of model.versions) if (selected.has(v.id)) n++;
    return n;
  }
  // Partial clears, matching the bar above it — two checkboxes on one screen disagreeing about what a
  // half-filled box does is worse than either choice.
  function toggleModel(model: CreatorModel) {
    const anySelected = selectedCount(model) > 0;
    for (const v of model.versions) {
      if (anySelected) selected.delete(v.id);
      else selected.add(v.id);
    }
  }

  const setFeeEnhance =
    () => async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await event.update({ reset: false });
      if (event.result.type === 'success') {
        toast.success('Licensing fee saved');
        // Refresh so the row chip reflects the new fee; keep the sheet open on the (now fresh) version.
        await invalidateAll();
        if (editing) {
          const id = editing.id;
          editing = view.models.flatMap((m) => m.versions).find((v) => v.id === id) ?? editing;
        }
      } else if (event.result.type === 'failure') {
        toast.error(String(event.result.data?.error ?? 'Failed to save'));
      }
    };

  // --- CSV export ---
  // Mirrors the current filters; drops the transient bulk/page params.
  const exportHref = $derived.by(() => {
    const params = new URLSearchParams(page.url.searchParams);
    params.delete('mode');
    params.delete('page');
    const qs = params.toString();
    return `/models/export${qs ? `?${qs}` : ''}`;
  });
  // Every filter the empty state offers to clear. `mt` and `usage` were missing, so filtering to a type
  // with no matches reported "you have no models" — and, under `for=sale`, "none of these can go on sale".
  const filterActive = $derived(
    !!view.query.q ||
      !!view.query.fee ||
      !!view.query.bm ||
      !!view.query.mt ||
      !!view.query.usage ||
      !!view.query.status ||
      view.query.access
  );

  // --- Early/paid-access editor (per-version drawer) ---
  let editing = $state<CreatorModelVersion | null>(null);
  // The parent model's type isn't on the version, so capture it when opening — the fee reference is keyed by it.
  let editingType = $state('');
  // The edited version's base model decides the media axis of every cap in the drawer.
  // One object per edited version — max, offered denominators and the suggestion all come from it, so
  // they cannot disagree with each other or with what the server enforces.
  const editingLimits = $derived(
    monetizationLimits({ tier, modelType: editingType, baseModel: editing?.baseModel })
  );
  // Per-model-type suggested fee behind the drawer's "Use this" shortcut.
  const suggested = $derived(
    feeToRatio(suggestedFee({ modelType: editingType, baseModel: editing?.baseModel }))
  );
  // Fee inputs are bound (not just seeded) so "Use this" can populate them from the reference.
  let feeBuzz = $state<number | undefined>();
  let feeImages = $state(String(DEFAULT_FEE_IMAGES));
  let feeAffirmed = $state(false);
  // Clearing a fee earns nothing, so only a non-zero fee needs the affirmation.
  const feeNeedsAffirmation = $derived(!!editing && !editing.rightsAffirmed && (feeBuzz ?? 0) > 0);

  // Opens the licensing drawer for a version. Seeds only the fee inputs here; the early/paid-access
  // editor (PaidAccessEditor) owns its own state, seeded from the version on mount.
  function openEditor(version: CreatorModelVersion, modelType: string) {
    editingType = modelType;
    feeAffirmed = false;
    // Denominator from the seed rule, amount from the version alone: an unset fee opens on the
    // suggestion's denominator with nothing priced until the creator types.
    feeBuzz = feeToRatio(version.licensingFee).buzz || undefined;
    feeImages = String(
      seedFeeRatio({ licensingFee: version.licensingFee, modelType, baseModel: version.baseModel })
        .images
    );
    editing = version;
  }
</script>

{#if pickingForSale}
  <!-- The whole page is in service of one question while this is up, so it replaces the page's own
       header and the caps strip rather than sitting under them. Controls stay enabled: a creator may
       legitimately want to fix a price or a gate before putting a version on sale. -->
  <div class="mb-4 rounded-lg border border-blue-4/40 bg-blue-4/10 p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex flex-col gap-1">
        <h1 class="text-2xl font-bold text-white">Sale preparation</h1>
        <p class="text-sm text-dark-1">
          Choose the versions to put on sale, then continue to set the discount and dates.
        </p>
        <p class="text-sm text-dark-2">
          Only versions sold with a permanent access price are listed — a sale takes Buzz off that
          price, so there is nothing for it to discount anywhere else.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span
          class="rounded-full border border-dark-4 bg-dark-6/60 px-2.5 py-1 text-xs font-medium tabular-nums text-dark-1"
        >
          {selected.size} selected
        </span>
        <Button
          size="sm"
          disabled={selected.size === 0}
          onclick={() => goto(`/sales?versions=${selectedIds.join(',')}`)}
        >
          Continue
        </Button>
        <Button variant="ghost" size="sm" href="/sales">Cancel</Button>
      </div>
    </div>
  </div>
{/if}

{#if !pickingForSale}
  <header class="page-header">
    <h1>Models</h1>
    <p>Set licensing fees, manage early/paid access, and sell access indefinitely — per version.</p>
  </header>
{/if}

{#if data.caps.capTier === 'free'}
  <JoinUpsell class="mb-6" />
{/if}

{#if !pickingForSale}
  <div
    class="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-dark-5 bg-dark-6/40 px-3 py-2 text-xs"
  >
    <span class="flex items-center gap-1.5">
      <span class="inline-block h-2 w-2 rounded-full bg-blue-4"></span>
      <span class="text-dark-2">Permanent access</span>
      {#if data.caps.permanentCap === 0}
        <span class="font-medium text-dark-2">Not available on your tier</span>
      {:else if data.caps.permanentCap === null}
        <span class="font-medium text-white">{data.caps.permanentUsed} set · unlimited</span>
      {:else}
        <span class="font-medium {permAtCap ? 'text-yellow-5' : 'text-white'}">
          {data.caps.permanentUsed} of {data.caps.permanentCap} set{permAtCap
            ? ' · limit reached'
            : ''}
        </span>
      {/if}
    </span>
    <span class="flex items-center gap-1.5">
      <span class="inline-block h-2 w-2 rounded-full bg-green-5"></span>
      <span class="text-dark-2">Early access</span>
      {#if data.caps.earlyAccessCap === 0}
        <span class="font-medium text-dark-2">Not unlocked yet — grows with your creator score</span
        >
      {:else}
        <span class="font-medium {eaAtCap ? 'text-yellow-5' : 'text-white'}">
          {data.caps.earlyAccessUsed} of {data.caps.earlyAccessCap} active{eaAtCap
            ? ' · limit reached'
            : ''}
        </span>
        <span class="text-dark-2">· up to {data.caps.maxEarlyAccessDays} days</span>
      {/if}
    </span>
    <details class="w-full">
      <summary
        class="cursor-pointer select-none text-dark-2 marker:text-dark-2 hover:text-white"
        data-testid="tier-caps-toggle"
      >
        Pricing limits · {data.caps.tier}
      </summary>
      <TierCapsTable capTier={data.caps.capTier} class="mt-3" />
    </details>
  </div>
{/if}

<!-- Search / filter / sort -->
<div class="mb-4 flex flex-wrap items-center gap-2">
  <form class="flex items-center gap-1" onsubmit={submitSearch}>
    <Input name="q" bind:value={() => term, typed} placeholder="Search models…" class="w-56" />
    <Button type="submit" variant="outline" size="icon" aria-label="Search" title="Search">
      <IconSearch size={16} />
    </Button>
  </form>
  <Popover.Root>
    <Popover.Trigger
      class="flex h-8 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm text-white transition-colors hover:bg-dark-6 dark:bg-input/30"
    >
      <IconFilter size={16} class="text-dark-2" />
      Filters
      {#if activeFilterCount > 0}
        <Badge class="px-1.5">{activeFilterCount}</Badge>
      {/if}
    </Popover.Trigger>
    <Popover.Content class="w-64 space-y-4 border-dark-4 bg-dark-7 p-4 text-sm text-white">
      <fieldset>
        <legend class="mb-2 text-xs font-medium uppercase tracking-wide text-dark-2">Status</legend>
        <RadioGroup
          value={view.query.status ?? ''}
          onValueChange={(v) => navigate({ status: v || null, page: null })}
        >
          {#each statusOptions as opt (opt.value)}
            {@const id = `status-${opt.value || 'active'}`}
            <div class="flex items-center gap-2">
              <RadioGroupItem value={opt.value} {id} />
              <Label for={id} class="cursor-pointer font-normal">{opt.label}</Label>
            </div>
          {/each}
        </RadioGroup>
      </fieldset>
      <div class="space-y-1.5">
        <Label for="filter-mt" class="text-xs font-medium uppercase tracking-wide text-dark-2">
          Model type
        </Label>
        <Select.Root
          type="single"
          value={view.query.mt ?? ''}
          onValueChange={(v: string) => navigate({ mt: v || null, page: null })}
        >
          <Select.Trigger
            id="filter-mt"
            size="default"
            class="w-full text-white"
            aria-label="Model type"
          >
            {view.query.mt || 'All types'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="" label="All types" />
            {#each view.modelTypes as mt (mt)}
              <Select.Item value={mt} label={mt} />
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="space-y-1.5">
        <Label for="filter-bm" class="text-xs font-medium uppercase tracking-wide text-dark-2">
          Base model
        </Label>
        <Select.Root
          type="single"
          value={view.query.bm ?? ''}
          onValueChange={(v: string) => navigate({ bm: v || null, page: null })}
        >
          <Select.Trigger
            id="filter-bm"
            size="default"
            class="w-full text-white"
            aria-label="Base model"
          >
            {view.query.bm || 'All base models'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="" label="All base models" />
            {#each view.baseModels as bm (bm)}
              <Select.Item value={bm} label={bm} />
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          id="filter-access"
          checked={view.query.access}
          onCheckedChange={(c) => navigate({ access: c ? '1' : null, page: null })}
        />
        <Label for="filter-access" class="cursor-pointer font-normal">Has early / paid access</Label
        >
      </div>
      <fieldset>
        <legend class="mb-2 text-xs font-medium uppercase tracking-wide text-dark-2"
          >Licensing fee</legend
        >
        <RadioGroup
          value={view.query.fee ?? ''}
          onValueChange={(v) => navigate({ fee: v || null, page: null })}
        >
          {#each feeOptions as opt (opt.value)}
            {@const id = `fee-${opt.value || 'all'}`}
            <div class="flex items-center gap-2">
              <RadioGroupItem value={opt.value} {id} />
              <Label for={id} class="cursor-pointer font-normal">{opt.label}</Label>
            </div>
          {/each}
        </RadioGroup>
      </fieldset>
      {#if activeFilterCount > 0}
        <Button
          variant="link"
          size="sm"
          class="h-auto p-0 text-xs"
          onclick={() =>
            navigate({ status: null, bm: null, mt: null, access: null, fee: null, page: null })}
        >
          Clear filters
        </Button>
      {/if}
    </Popover.Content>
  </Popover.Root>
  <Select.Root
    type="single"
    value={view.query.sort}
    onValueChange={(v: string) => {
      if (v) navigate({ sort: v, page: null });
    }}
  >
    <Select.Trigger size="default" class="w-44 text-white" aria-label="Sort">
      {view.query.sort === 'name' ? 'Name' : 'Recently updated'}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="recent" label="Recently updated" />
      <Select.Item value="name" label="Name" />
    </Select.Content>
  </Select.Root>
</div>

<div class="mb-4 flex items-center justify-between gap-2">
  <p class="text-xs text-dark-2">{view.total} model{view.total === 1 ? '' : 's'}</p>
  <label class="flex items-center gap-1.5 text-xs text-dark-2">
    Per page
    <Select.Root
      type="single"
      value={String(view.perPage)}
      onValueChange={(v: string) => {
        if (v) navigate({ ps: v, page: null });
      }}
    >
      <Select.Trigger size="sm" class="w-16 text-white" aria-label="Models per page">
        {view.perPage}
      </Select.Trigger>
      <Select.Content>
        {#each data.pageSizeOptions as n (n)}
          <Select.Item value={String(n)} label={String(n)} />
        {/each}
      </Select.Content>
    </Select.Root>
  </label>
</div>

{#if overCapVersions.length > 0}
  <div class="mb-3 rounded-lg border border-yellow-5/30 bg-yellow-5/10 px-3 py-2 text-sm">
    <p class="font-medium text-yellow-4">
      {overCapVersions.length} version{overCapVersions.length === 1 ? '' : 's'} earn less than the fee
      you set
    </p>
    <p class="mt-0.5 text-xs text-dark-2">
      Your membership tier caps what a generation can charge, so these are billed at the capped rate
      — the stored fee applies again if you upgrade.
    </p>
    <ul class="mt-1.5 max-h-24 overflow-y-auto text-xs text-dark-1">
      {#each overCapVersions.slice(0, 10) as v (v.name)}
        <li class="truncate">
          {v.name} — set {v.stored} ⚡, earning {v.effective} ⚡ / generation
        </li>
      {/each}
    </ul>
    {#if overCapVersions.length > 10}
      <p class="mt-1 text-xs text-dark-2">…and {overCapVersions.length - 10} more.</p>
    {/if}
  </div>
{/if}

{#if view.total > 0 || selected.size > 0}
  <BulkBar
    count={selected.size}
    matchingCount={view.matchingVersionIds.length}
    {allMatchingSelected}
    {offViewCount}
    {exportHref}
    onAction={(a) => (bulkAction = a)}
    onStartSale={() => goto(`/sales?versions=${selectedIds.join(',')}`)}
    salesEnabled={data.salesEnabled}
    onSelectAllMatching={() => {
      for (const id of view.matchingVersionIds) selected.add(id);
    }}
    onClear={() => selected.clear()}
  />
{/if}

<BulkActionDialog
  bind:action={bulkAction}
  versionIds={selectedIds}
  limits={bulkLimits}
  feeCapsByType={selectionFeeCaps}
  capTier={tier}
  capFor={(t, imgs) => feeMaxFor(strictestLimits(t), imgs)}
  accessCapFor={(t) => finiteOrNull(maxPaidAccessPrice(t))}
  caps={data.caps}
  suggestedFee={bulkSuggested}
  needsAffirmation={selectionNeedsAffirmation}
  permanentSlotsLeft={remainingPermanentSlots - newSlotsUsed + selected.size}
/>

<!-- Dimmed rather than emptied while a search settles: replacing results with a spinner makes every
     keystroke flash the whole list, and the previous rows are still the honest answer until new ones land. -->
<div aria-busy={searching} class={searching ? 'opacity-60 transition-opacity' : undefined}>
  {#if view.models.length === 0}
    <div class="placeholder">
      {#if filterActive}
        No models match your filters. <button
          class="underline"
          onclick={() =>
            navigate({
              q: null,
              fee: null,
              bm: null,
              mt: null,
              usage: null,
              status: null,
              access: null,
              page: null,
            })}>Clear</button
        >
      {:else if view.query.saleOnly}
        Nothing here can go on sale. A sale discounts a permanent access price, so price a version
        first — early access and licensing fees aren't what a sale takes Buzz off.
        <a href="/models">Set a price</a>
      {:else}
        You have no models yet. <a href="https://civitai.com/models/create"
          >Upload one on civitai.com</a
        > to get started.
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-5">
      {#each view.models as model (model.id)}
        <Card>
          <CardHeader>
            <div class="flex items-center gap-3">
              {#if model.versions.length > 0}
                {@const mId = `m-${model.id}`}
                {@const picked = selectedCount(model)}
                <Checkbox
                  id={mId}
                  checked={picked === model.versions.length}
                  indeterminate={picked > 0 && picked < model.versions.length}
                  onCheckedChange={() => toggleModel(model)}
                  aria-label="Select all versions of {model.name}"
                />
                <Label for={mId} class="cursor-pointer">
                  <CardTitle class="text-base text-white">{model.name}</CardTitle>
                </Label>
              {:else}
                <CardTitle class="text-base text-white">{model.name}</CardTitle>
              {/if}
              <Badge variant="secondary">{model.type}</Badge>
              <Badge variant={model.status === 'Published' ? 'default' : 'outline'} class="ml-auto">
                {model.status}
              </Badge>
              {#if model.versions.length > 0}
                <a
                  href={modelUrl(model.id, model)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on Civitai"
                  aria-label="View {model.name} on Civitai"
                  class="shrink-0 rounded-md p-1 text-dark-2 hover:bg-dark-6 hover:text-white"
                >
                  <IconExternalLink size={16} />
                </a>
              {/if}
            </div>
          </CardHeader>
          <CardContent class="p-0">
            {#if model.versions.length === 0}
              <p class="px-5 py-4 text-sm text-dark-2">No versions.</p>
            {:else}
              <ul class="divide-y divide-dark-4 border-t border-dark-4">
                {#each model.versions as version (version.id)}
                  {@const chip = feeChip(version.licensingFee, model.type, version.baseModel)}
                  {@const cbId = `v-${version.id}`}
                  <li>
                    <div
                      class="flex w-full items-center gap-3 px-5 hover:bg-dark-6/40"
                      class:bg-dark-6={selected.has(version.id)}
                    >
                      <Checkbox
                        id={cbId}
                        checked={selected.has(version.id)}
                        onCheckedChange={() => toggleVersion(version.id)}
                        aria-label="Select {version.name}"
                        class="shrink-0"
                      />
                      <button
                        type="button"
                        onclick={() => openEditor(version, model.type)}
                        class="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 py-3 text-left sm:flex-row sm:items-center sm:gap-3"
                      >
                        <span class="flex min-w-0 items-center gap-2 sm:flex-1">
                          <span class="truncate text-sm font-medium text-white">{version.name}</span
                          >
                          <Badge variant="secondary" class="shrink-0 text-[10px]"
                            >{version.baseModel}</Badge
                          >
                          <Badge
                            variant="outline"
                            class="{statusBadgeCls(
                              version.status
                            )} ml-auto shrink-0 text-[10px] uppercase tracking-wide sm:ml-0"
                          >
                            {version.status}
                          </Badge>
                        </span>
                        <span class="flex shrink-0 items-center gap-2">
                          {#if version.paidAccessConfig}
                            {@const ab = accessBadge(version.paidAccessConfig)}
                            <Badge variant="outline" class={ab.cls} title={ab.title}
                              >{ab.label}</Badge
                            >
                          {/if}
                          <Badge variant="outline" class={chip.cls}>{chip.label}</Badge>
                          <IconChevronRight
                            size={16}
                            class="ml-auto shrink-0 text-dark-2 sm:ml-0"
                          />
                        </span>
                      </button>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </CardContent>
        </Card>
      {/each}
    </div>

    {#if view.pageCount > 1}
      <Pagination.Root
        count={view.total}
        perPage={view.perPage}
        page={view.page}
        onPageChange={(p) => navigate({ page: String(p) })}
        class="mt-6"
      >
        {#snippet children({ pages, currentPage })}
          <Pagination.Content>
            <Pagination.Item>
              <Pagination.PrevButton aria-label="Previous page">
                <IconChevronLeft size={16} />
              </Pagination.PrevButton>
            </Pagination.Item>
            {#each pages as p (p.key)}
              {#if p.type === 'ellipsis'}
                <Pagination.Item>
                  <Pagination.Ellipsis />
                </Pagination.Item>
              {:else}
                <Pagination.Item>
                  <Pagination.Link page={p} isActive={currentPage === p.value}>
                    {p.value}
                  </Pagination.Link>
                </Pagination.Item>
              {/if}
            {/each}
            <Pagination.Item>
              <Pagination.NextButton aria-label="Next page">
                <IconChevronRight size={16} />
              </Pagination.NextButton>
            </Pagination.Item>
          </Pagination.Content>
        {/snippet}
      </Pagination.Root>
    {/if}
  {/if}
</div>

<Sheet
  open={editing != null}
  onOpenChange={(o) => {
    if (!o) editing = null;
  }}
>
  <SheetContent side="right" class="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
    {#if editing}
      {@const st = feeStatus(editing.licensingFee, editingType, editing.baseModel)}
      <SheetHeader class="border-b border-dark-4 p-5">
        <SheetTitle class="text-white">{editing.name}</SheetTitle>
        <SheetDescription>{editing.baseModel} · {editing.status}</SheetDescription>
      </SheetHeader>

      <div class="flex flex-col gap-6 p-5">
        <!-- Licensing fee -->
        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-white">Licensing fee</span>
            <span class="text-xs {st.cls}">{st.label}</span>
          </div>
          <form
            method="POST"
            action="?/setFee"
            use:enhance={setFeeEnhance}
            class="flex flex-wrap items-center gap-1.5"
          >
            <input type="hidden" name="versionId" value={editing.id} />
            <LicensingFeeFields
              bind:buzz={feeBuzz}
              bind:images={feeImages}
              limits={editingLimits}
              capTier={data.caps.capTier}
              capFor={(t, imgs) =>
                feeMaxFor(
                  monetizationLimits({
                    tier: t,
                    modelType: editingType,
                    baseModel: editing?.baseModel,
                  }),
                  imgs
                )}
              {suggested}
              ariaLabelSuffix=" for {editing.name}"
            />
            {#if feeNeedsAffirmation}
              <RightsAffirmation bind:checked={feeAffirmed} />
            {/if}
            <Button
              type="submit"
              size="sm"
              class="w-full"
              disabled={feeNeedsAffirmation && !feeAffirmed}
            >
              Save fee
            </Button>
          </form>
        </section>

        {#key editing.id}
          <PaidAccessEditor
            version={editing}
            onClose={() => (editing = null)}
            caps={data.caps}
            sales={view.salesByVersion[editing.id]}
          />
        {/key}
      </div>
    {/if}
  </SheetContent>
</Sheet>
