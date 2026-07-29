<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteSet } from 'svelte/reactivity';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogCancel,
    AlertDialogAction,
  } from '@civitai/ui/components/ui/alert-dialog/index.js';
  import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
    SheetFooter,
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
    formatFeeRatio,
    suggestedFeePerImage,
    FEE_IMAGE_OPTIONS,
    DEFAULT_FEE_IMAGES,
  } from '$lib/monetization/fee';
  import JoinUpsell from '$lib/components/JoinUpsell.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import PaidAccessBulkBar from '$lib/components/PaidAccessBulkBar.svelte';
  import PaidAccessEditor from '$lib/components/PaidAccessEditor.svelte';
  import BulkLicensingFeesBar from '$lib/components/BulkLicensingFeesBar.svelte';
  import {
    IconSearch,
    IconFilter,
    IconChevronLeft,
    IconChevronRight,
    IconExternalLink,
  } from '@tabler/icons-svelte';
  import { modelUrl } from '$lib/model-url';
  import type { PageData } from './$types';
  import type { CreatorModel, CreatorModelVersion } from '$lib/server/models';

  let { data }: { data: PageData } = $props();

  // Off / Active / Paused — a fee is "paused" (kept but not charged) when the owner isn't currently a CP member.
  function feeStatus(fee: number | null): { label: string; cls: string } {
    if (fee == null) return { label: 'Off', cls: 'text-dark-3' };
    return data.canSetFee
      ? { label: 'Active', cls: 'text-green-5' }
      : { label: 'Paused', cls: 'text-yellow-5' };
  }

  // Compact fee chip for a scan row: colour mirrors feeStatus (green Active / yellow Paused / dim Off).
  function feeChip(fee: number | null): { label: string; cls: string } {
    if (fee == null) return { label: 'Fee off', cls: 'border-dark-4 text-dark-3' };
    const { buzz, images } = feeToRatio(fee);
    const label = images === 1 ? `${buzz} ⚡ / img` : `${buzz} ⚡ / ${images}`;
    return data.canSetFee
      ? { label, cls: 'border-green-5/30 bg-green-5/10 text-green-5' }
      : { label, cls: 'border-yellow-5/30 bg-yellow-5/10 text-yellow-5' };
  }

  // Early-access chip: shown (green) only while a window is actually active, so it clearly means
  // "early access is on" and nothing else.
  const eaChipCls = 'border-green-5/30 bg-green-5/10 text-green-5';
  // Permanent (sold indefinitely) is a different product from a timed early-access window — distinct colour so
  // the two never read as the same thing.
  const permChipCls = 'border-blue-4/30 bg-blue-4/10 text-blue-3';
  // Permanent access is capped by CP tier (null cap = unlimited); concurrent early access by models score.
  const permAtCap = $derived(
    data.permanentCap !== null && data.permanentCap > 0 && data.permanentUsed >= data.permanentCap
  );
  const eaAtCap = $derived(data.earlyAccessCap > 0 && data.earlyAccessUsed >= data.earlyAccessCap);

  // Version status as a distinct tag (M5) — green when Published, dim for Draft/other — so it reads as a badge
  // rather than blending into the base-model text.
  function statusBadgeCls(status: string): string {
    return status === 'Published'
      ? 'border-green-5/30 bg-green-5/10 text-green-5'
      : 'border-dark-4 bg-dark-6 text-dark-3';
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
    (data.query.status ? 1 : 0) +
      (data.query.bm ? 1 : 0) +
      (data.query.mt ? 1 : 0) +
      (data.query.access ? 1 : 0) +
      (data.query.fee ? 1 : 0)
  );

  // --- URL-driven table state (search / fee filter / sort / pagination) ---
  function navigate(params: Record<string, string | null>) {
    goto(buildHref(params), { keepFocus: true, noScroll: true, replaceState: true });
  }

  // Build an href off the current URL, applying overrides — so links (bulk mode on/off) preserve the active
  // filters/sort/page instead of resetting them (868ke491x bulk-edit-clears-filters bug).
  function buildHref(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams(page.url.searchParams);
    for (const [k, v] of Object.entries(overrides)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    const qs = params.toString();
    return qs ? `${page.url.pathname}?${qs}` : page.url.pathname;
  }

  // Search fires on Enter, on blur, and via the button — all no-op if the term is unchanged.
  function runSearch(raw: FormDataEntryValue | string | null) {
    const q = String(raw ?? '').trim();
    if (q === (data.query.q ?? '')) return;
    navigate({ q: q || null, page: null });
  }

  // --- Bulk mode ---
  const bulkMode = $derived(data.canSetFee && page.url.searchParams.get('mode') === 'bulk');
  // Bulk permanent paid-access pricing — a separate mode/bar from fees, members only.
  const paidAccessMode = $derived(
    data.canSellIndefinitely && page.url.searchParams.get('mode') === 'paid-access'
  );
  // Either mode shares the same version-selection UI.
  const selectionMode = $derived(bulkMode || paidAccessMode);
  // Paid-access bulk is scoped to one usage type — the toggle drives a `usage` list filter so the price
  // fields are unambiguous and "select all" is exact. Defaults to downloadable.
  const bulkUsage = $derived(data.query.usage === 'generation' ? 'generation' : 'download');
  // A reactive Set — in-place add/delete/clear stay fine-grained (no reassign-to-mutate).
  const selected = new SvelteSet<number>();
  // Permanent slots the creator can still fill (null cap = unlimited). Caps how many can be selected in
  // paid-access mode so a batch can never exceed the tier — "max minus current".
  const remainingPermanentSlots = $derived(
    data.permanentCap === null ? Infinity : Math.max(0, data.permanentCap - data.permanentUsed)
  );
  const maxSelectable = $derived(paidAccessMode ? remainingPermanentSlots : Infinity);
  // The suggested fee is per model type, so surface a bulk "use suggested" only when the type filter pins one.
  const bulkSuggested = $derived(data.query.mt ? suggestedFeePerImage(data.query.mt) : undefined);

  // Leaving bulk mode (Cancel, or any URL change that drops the mode) discards a pending selection.
  $effect(() => {
    if (!selectionMode && selected.size > 0) selected.clear();
  });

  function toggleVersion(id: number) {
    if (selected.has(id)) selected.delete(id);
    else if (selected.size < maxSelectable) selected.add(id);
    else toast.error(`You can select up to ${maxSelectable} version${maxSelectable === 1 ? '' : 's'} for permanent access.`);
  }
  function allSelected(model: CreatorModel) {
    return model.versions.length > 0 && model.versions.every((v) => selected.has(v.id));
  }
  function toggleModel(model: CreatorModel) {
    const all = allSelected(model);
    for (const v of model.versions) {
      if (all) selected.delete(v.id);
      else if (selected.size < maxSelectable) selected.add(v.id);
    }
  }
  function selectAll(ids: number[]) {
    selected.clear();
    for (const id of ids) {
      if (selected.size >= maxSelectable) break;
      selected.add(id);
    }
  }
  // Switch the paid-access usage scope: clears the (now off-list) selection and re-filters the list.
  function setBulkUsage(usage: 'download' | 'generation') {
    if (usage === bulkUsage) return;
    selected.clear();
    navigate({ usage, page: null });
  }

  const setFeeEnhance = () => async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
    await event.update({ reset: false });
    if (event.result.type === 'success') {
      toast.success('Licensing fee saved');
      // Refresh so the row chip reflects the new fee; keep the sheet open on the (now fresh) version.
      await invalidateAll();
      if (editing) {
        const id = editing.id;
        editing = data.models.flatMap((m) => m.versions).find((v) => v.id === id) ?? editing;
      }
    } else if (event.result.type === 'failure') {
      toast.error(String(event.result.data?.error ?? 'Failed to save'));
    }
  };

  // --- CSV import/export ---
  // Export mirrors the current filters; drop the transient bulk/page params.
  const exportHref = $derived.by(() => {
    const params = new URLSearchParams(page.url.searchParams);
    params.delete('mode');
    params.delete('page');
    const qs = params.toString();
    return `/models/export${qs ? `?${qs}` : ''}`;
  });
  type FeeChange = {
    versionId: number;
    row?: number;
    modelName: string;
    versionName: string;
    baseModel: string;
    current: number | null;
    next: number | null;
  };
  let fileInput = $state<HTMLInputElement>();
  let previewForm = $state<HTMLFormElement>();
  let applyForm = $state<HTMLFormElement>();
  let preview = $state<{ changes: FeeChange[]; unchanged: number; skipped: { row?: number; reason: string }[] } | null>(null);
  let showPreview = $state(false);
  let applying = $state(false);

  // Upload → dry-run: show the diff + any skipped rows in a modal; nothing is written until the creator confirms.
  const previewEnhance = () => async (event: { result: any; update: () => Promise<void> }) => {
    if (fileInput) fileInput.value = '';
    if (event.result.type === 'success') {
      preview = event.result.data;
      showPreview = true;
    } else if (event.result.type === 'failure') {
      toast.error(String(event.result.data?.error ?? 'Could not read that file'));
    }
  };

  const applyEnhance = () => async (event: { result: any; update: () => Promise<void> }) => {
    applying = false;
    if (event.result.type === 'success') {
      const n = Number(event.result.data?.updated ?? 0);
      const skip = Number(event.result.data?.skippedCount ?? 0);
      toast.success(`Updated ${n} fee${n === 1 ? '' : 's'}${skip ? ` · ${skip} skipped` : ''}`);
      showPreview = false;
      preview = null;
      await invalidateAll();
    } else if (event.result.type === 'failure') {
      toast.error(String(event.result.data?.error ?? 'Import failed'));
    }
  };

  const filterActive = $derived(
    !!data.query.q || !!data.query.fee || !!data.query.bm || !!data.query.status || data.query.access
  );

  // --- Early/paid-access editor (per-version drawer) ---
  let editing = $state<CreatorModelVersion | null>(null);
  // The parent model's type isn't on the version, so capture it when opening — the fee reference is keyed by it.
  let editingType = $state('');
  // Fee inputs are bound (not just seeded) so "Use this" can populate them from the reference.
  let feeBuzz = $state<number | undefined>();
  let feeImages = $state(String(DEFAULT_FEE_IMAGES));

  // Opens the licensing drawer for a version. Seeds only the fee inputs here; the early/paid-access
  // editor (EarlyAccessEditor) owns its own state, seeded from the version on mount.
  function openEditor(version: CreatorModelVersion, modelType: string) {
    editingType = modelType;
    const r = feeToRatio(version.licensingFee);
    feeBuzz = r.buzz || undefined;
    feeImages = String(r.images);
    editing = version;
  }
</script>

<header class="page-header">
  <h1>Licensing</h1>
  <p>Set licensing fees, manage early/paid access, and sell access indefinitely — per version.</p>
</header>

{#if !data.canSetFee}
  <JoinUpsell
    class="mb-6"
    body="Setting licensing fees requires an active Creator Program membership. You can still review your models below."
  />
{/if}

<div
  class="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-dark-5 bg-dark-6/40 px-3 py-2 text-xs"
>
  <span class="flex items-center gap-1.5">
    <span class="inline-block h-2 w-2 rounded-full bg-blue-4"></span>
    <span class="text-dark-2">Permanent access</span>
    {#if data.permanentCap === 0}
      <span class="font-medium text-dark-3">Not available on your tier</span>
    {:else if data.permanentCap === null}
      <span class="font-medium text-white">{data.permanentUsed} set · unlimited</span>
    {:else}
      <span class="font-medium {permAtCap ? 'text-yellow-5' : 'text-white'}">
        {data.permanentUsed} of {data.permanentCap} set{permAtCap ? ' · limit reached' : ''}
      </span>
    {/if}
  </span>
  <span class="flex items-center gap-1.5">
    <span class="inline-block h-2 w-2 rounded-full bg-green-5"></span>
    <span class="text-dark-2">Early access</span>
    {#if data.earlyAccessCap === 0}
      <span class="font-medium text-dark-3">Not unlocked yet — grows with your creator score</span>
    {:else}
      <span class="font-medium {eaAtCap ? 'text-yellow-5' : 'text-white'}">
        {data.earlyAccessUsed} of {data.earlyAccessCap} active{eaAtCap ? ' · limit reached' : ''}
      </span>
      <span class="text-dark-3">· up to {data.maxEarlyAccessDays} days</span>
    {/if}
  </span>
</div>

<!-- Search / filter / sort -->
<div class="mb-4 flex flex-wrap items-center gap-2">
  <form
    class="flex items-center gap-1"
    onsubmit={(e) => {
      e.preventDefault();
      runSearch(new FormData(e.currentTarget).get('q'));
    }}
  >
    <Input
      name="q"
      value={data.query.q}
      placeholder="Search models…"
      onblur={(e) => runSearch(e.currentTarget.value)}
      class="w-56"
    />
    <Button type="submit" variant="outline" size="icon" aria-label="Search" title="Search">
      <IconSearch size={16} />
    </Button>
  </form>
  <Popover.Root>
    <Popover.Trigger
      class="flex h-8 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm text-white transition-colors hover:bg-dark-6 dark:bg-input/30"
    >
      <IconFilter size={16} class="text-dark-3" />
      Filters
      {#if activeFilterCount > 0}
        <Badge class="px-1.5">{activeFilterCount}</Badge>
      {/if}
    </Popover.Trigger>
    <Popover.Content class="w-64 space-y-4 border-dark-4 bg-dark-7 p-4 text-sm text-white">
      <fieldset>
        <legend class="mb-2 text-xs font-medium uppercase tracking-wide text-dark-2">Status</legend>
        <RadioGroup
          value={data.query.status ?? ''}
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
          value={data.query.mt ?? ''}
          onValueChange={(v: string) => navigate({ mt: v || null, page: null })}
        >
          <Select.Trigger id="filter-mt" size="default" class="w-full text-white" aria-label="Model type">
            {data.query.mt || 'All types'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="" label="All types" />
            {#each data.modelTypes as mt (mt)}
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
          value={data.query.bm ?? ''}
          onValueChange={(v: string) => navigate({ bm: v || null, page: null })}
        >
          <Select.Trigger id="filter-bm" size="default" class="w-full text-white" aria-label="Base model">
            {data.query.bm || 'All base models'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="" label="All base models" />
            {#each data.baseModels as bm (bm)}
              <Select.Item value={bm} label={bm} />
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          id="filter-access"
          checked={data.query.access}
          onCheckedChange={(c) => navigate({ access: c ? '1' : null, page: null })}
        />
        <Label for="filter-access" class="cursor-pointer font-normal">Has early / paid access</Label>
      </div>
      <fieldset>
        <legend class="mb-2 text-xs font-medium uppercase tracking-wide text-dark-2">Licensing fee</legend>
        <RadioGroup
          value={data.query.fee ?? ''}
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
    value={data.query.sort}
    onValueChange={(v: string) => {
      if (v) navigate({ sort: v, page: null });
    }}
  >
    <Select.Trigger size="default" class="w-44 text-white" aria-label="Sort">
      {data.query.sort === 'name' ? 'Name' : 'Recently updated'}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="recent" label="Recently updated" />
      <Select.Item value="name" label="Name" />
    </Select.Content>
  </Select.Root>
  {#if data.total > 0 && !selectionMode}
    <div class="ml-auto flex items-center gap-2">
      <Button href={exportHref} data-sveltekit-reload variant="outline" size="sm">Export CSV</Button>
      {#if data.canSetFee}
        <form
          bind:this={previewForm}
          method="POST"
          action="?/previewFees"
          enctype="multipart/form-data"
          use:enhance={previewEnhance}
          class="contents"
        >
          <input
            bind:this={fileInput}
            type="file"
            name="file"
            accept=".csv,text/csv"
            class="hidden"
            onchange={() => previewForm?.requestSubmit()}
          />
        </form>
        <Button variant="outline" size="sm" onclick={() => fileInput?.click()}>Import CSV</Button>
        {#if data.canSellIndefinitely}
          <Button
            href={buildHref({ mode: 'paid-access', usage: 'download' })}
            data-sveltekit-replacestate
            variant="outline"
            size="sm"
          >
            Bulk Paid Access
          </Button>
        {/if}
        <Button href={buildHref({ mode: 'bulk' })} data-sveltekit-replacestate variant="outline" size="sm">
          Bulk Edit Fees
        </Button>
      {/if}
    </div>
  {/if}
</div>

<div class="mb-4 flex items-center justify-between gap-2">
  <p class="text-xs text-dark-3">{data.total} model{data.total === 1 ? '' : 's'}</p>
  <label class="flex items-center gap-1.5 text-xs text-dark-3">
    Per page
    <Select.Root
      type="single"
      value={String(data.perPage)}
      onValueChange={(v: string) => {
        if (v) navigate({ ps: v, page: null });
      }}
    >
      <Select.Trigger size="sm" class="w-16 text-white" aria-label="Models per page">
        {data.perPage}
      </Select.Trigger>
      <Select.Content>
        {#each data.pageSizeOptions as n (n)}
          <Select.Item value={String(n)} label={String(n)} />
        {/each}
      </Select.Content>
    </Select.Root>
  </label>
</div>

{#if bulkMode}
  <BulkLicensingFeesBar
    matchingVersionIds={data.matchingVersionIds}
    {selected}
    suggestedFee={bulkSuggested}
    cancelHref={buildHref({ mode: null })}
    onSelectAll={selectAll}
  />
{/if}

{#if paidAccessMode}
  <PaidAccessBulkBar
    permanentCap={data.permanentCap}
    permanentUsed={data.permanentUsed}
    matchingVersionIds={data.matchingVersionIds}
    usage={bulkUsage}
    {selected}
    onSetUsage={setBulkUsage}
    onSelectAll={selectAll}
    cancelHref={buildHref({ mode: null, usage: null })}
  />
{/if}

{#if data.models.length === 0}
  <div class="placeholder">
    {#if filterActive}
      No models match your filters. <button
        class="underline"
        onclick={() => navigate({ q: null, fee: null, bm: null, status: null, access: null, page: null })}
      >Clear</button>
    {:else}
      You have no models yet. <a href="https://civitai.com/models/create">Upload one on civitai.com</a> to get started.
    {/if}
  </div>
{:else}
  <div class="flex flex-col gap-5">
    {#each data.models as model (model.id)}
      <Card>
        <CardHeader>
          <div class="flex items-center gap-3">
            {#if selectionMode && model.versions.length > 0}
              {@const mId = `m-${model.id}`}
              <Checkbox
                id={mId}
                checked={allSelected(model)}
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
            {#if !selectionMode}
              <a
                href={modelUrl(model.id, model)}
                target="_blank"
                rel="noopener noreferrer"
                title="View on Civitai"
                aria-label="View {model.name} on Civitai"
                class="shrink-0 rounded-md p-1 text-dark-3 hover:bg-dark-6 hover:text-white"
              >
                <IconExternalLink size={16} />
              </a>
            {/if}
          </div>
        </CardHeader>
        <CardContent class="p-0">
          {#if model.versions.length === 0}
            <p class="px-5 py-4 text-sm text-dark-3">No versions.</p>
          {:else}
            <ul class="divide-y divide-dark-4 border-t border-dark-4">
              {#each model.versions as version (version.id)}
                {@const chip = feeChip(version.licensingFee)}
                <li>
                  {#if selectionMode}
                    {@const cbId = `v-${version.id}`}
                    <div class="flex w-full items-center gap-3 px-5 py-3">
                      <Checkbox
                        id={cbId}
                        checked={selected.has(version.id)}
                        onCheckedChange={() => toggleVersion(version.id)}
                        aria-label="Select {version.name}"
                        class="shrink-0"
                      />
                      <Label for={cbId} class="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-2 font-normal">
                        <span class="truncate text-sm font-medium text-white">{version.name}</span>
                        <Badge variant="outline" class="{statusBadgeCls(version.status)} text-[10px] uppercase tracking-wide">
                          {version.status}
                        </Badge>
                        <Badge variant="secondary" class="text-[10px]">{version.baseModel}</Badge>
                      </Label>
                      <Badge variant="outline" class="{chip.cls} shrink-0">{chip.label}</Badge>
                    </div>
                  {:else}
                    <button
                      type="button"
                      onclick={() => openEditor(version, model.type)}
                      class="flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left hover:bg-dark-6/40"
                    >
                      <span class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <span class="truncate text-sm font-medium text-white">{version.name}</span>
                        <Badge variant="outline" class="{statusBadgeCls(version.status)} text-[10px] uppercase tracking-wide">
                          {version.status}
                        </Badge>
                        <Badge variant="secondary" class="text-[10px]">{version.baseModel}</Badge>
                      </span>
                      <span class="flex shrink-0 items-center gap-2">
                        {#if version.earlyAccessConfig?.permanent}
                          <Badge
                            variant="outline"
                            class={permChipCls}
                            title="Sold indefinitely — paid access with no end date"
                          >
                            Permanent
                          </Badge>
                        {:else if version.hasEarlyAccess}
                          <Badge
                            variant="outline"
                            class={eaChipCls}
                            title="Timed early access — becomes free when the window ends"
                          >
                            Early access
                          </Badge>
                        {/if}
                        <Badge variant="outline" class={chip.cls}>{chip.label}</Badge>
                        <IconChevronRight size={16} class="text-dark-3" />
                      </span>
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </CardContent>
      </Card>
    {/each}
  </div>

  {#if data.pageCount > 1}
    <Pagination.Root
      count={data.total}
      perPage={data.perPage}
      page={data.page}
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

<AlertDialog bind:open={showPreview}>
  <AlertDialogContent class="max-w-2xl">
    <AlertDialogHeader>
      <AlertDialogTitle>
        Review changes · {preview?.changes.length ?? 0} to update
      </AlertDialogTitle>
      <AlertDialogDescription>
        {preview?.changes.length ?? 0} fee{preview?.changes.length === 1 ? '' : 's'} will change · {preview?.unchanged ?? 0} unchanged{(preview?.skipped.length ?? 0) > 0 ? ` · ${preview?.skipped.length} skipped` : ''}. Nothing is saved until you confirm.
      </AlertDialogDescription>
    </AlertDialogHeader>

    {#if (preview?.changes.length ?? 0) > 0}
      <div class="max-h-72 overflow-y-auto rounded-lg border border-dark-4">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-dark-7 text-xs uppercase tracking-wide text-dark-3">
            <tr>
              <th class="px-3 py-2 text-left font-medium">Version</th>
              <th class="px-3 py-2 text-right font-medium">Current</th>
              <th class="px-3 py-2 text-right font-medium">New</th>
            </tr>
          </thead>
          <tbody>
            {#each (preview?.changes ?? []).slice(0, 100) as c (c.versionId)}
              <tr class="border-t border-dark-4">
                <td class="px-3 py-1.5 text-dark-1">
                  <span class="text-white">{c.modelName}</span>
                  <span class="text-dark-3">· {c.versionName} · {c.baseModel}</span>
                </td>
                <td class="px-3 py-1.5 text-right tabular-nums text-dark-3">{formatFeeRatio(c.current)}</td>
                <td class="px-3 py-1.5 text-right tabular-nums font-medium text-white">{formatFeeRatio(c.next)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if (preview?.changes.length ?? 0) > 100}
        <p class="text-xs text-dark-3">Showing the first 100 of {preview?.changes.length} changes — all will be applied.</p>
      {/if}
    {:else}
      <p class="rounded-lg border border-dark-4 p-3 text-sm text-dark-2">No fees would change.</p>
    {/if}

    {#if (preview?.skipped.length ?? 0) > 0}
      <details class="rounded-lg border border-dark-4 p-3 text-sm">
        <summary class="cursor-pointer text-yellow-5">{preview?.skipped.length} row(s) skipped</summary>
        <ul class="mt-2 max-h-40 space-y-1 overflow-y-auto text-dark-1">
          {#each preview?.skipped ?? [] as s (s.row)}
            <li><span class="text-dark-3">Row {s.row}:</span> {s.reason}</li>
          {/each}
        </ul>
      </details>
    {/if}

    <form
      bind:this={applyForm}
      method="POST"
      action="?/applyFees"
      use:enhance={applyEnhance}
      class="contents"
    >
      <input type="hidden" name="changes" value={JSON.stringify((preview?.changes ?? []).map((c) => ({ versionId: c.versionId, fee: c.next })))} />
    </form>
    <AlertDialogFooter>
      <AlertDialogCancel onclick={() => (preview = null)}>Cancel</AlertDialogCancel>
      <AlertDialogAction
        disabled={(preview?.changes.length ?? 0) === 0 || applying}
        onclick={(e: Event) => {
          e.preventDefault();
          applying = true;
          applyForm?.requestSubmit();
        }}
      >
        Save {preview?.changes.length ?? 0} change{preview?.changes.length === 1 ? '' : 's'}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>

<Sheet open={editing != null} onOpenChange={(o) => { if (!o) editing = null; }}>
  <SheetContent side="right" class="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
    {#if editing}
      {@const st = feeStatus(editing.licensingFee)}
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
          {#if data.canSetFee}
            {@const suggested = feeToRatio(suggestedFeePerImage(editingType))}
            <form method="POST" action="?/setFee" use:enhance={setFeeEnhance} class="flex flex-wrap items-center gap-1.5">
              <input type="hidden" name="versionId" value={editing.id} />
              <NumberInput
                name="buzz"
                min={0}
                bind:value={feeBuzz}
                placeholder="Off"
                aria-label="Buzz for {editing.name}"
                class="w-16 py-1"
              />
              <span class="text-xs text-dark-3">⚡ per</span>
              <input type="hidden" name="images" value={feeImages} />
              <Select.Root type="single" value={feeImages} onValueChange={(v: string) => { if (v) feeImages = v; }}>
                <Select.Trigger size="default" class="w-16 text-white" aria-label="Images for {editing.name}">
                  {feeImages}
                </Select.Trigger>
                <Select.Content>
                  {#each FEE_IMAGE_OPTIONS as opt (opt)}
                    <Select.Item value={String(opt)} label={String(opt)} />
                  {/each}
                </Select.Content>
              </Select.Root>
              <span class="text-xs text-dark-3">images</span>
              <Button type="submit" size="sm" class="ml-auto">Save fee</Button>
              <p class="w-full text-xs text-dark-3">
                Suggested for {editingType}: {suggested.buzz} ⚡ / {suggested.images === 1
                  ? 'image'
                  : `${suggested.images} images`}
                <button
                  type="button"
                  class="ml-1 text-blue-4 hover:underline"
                  onclick={() => {
                    feeBuzz = suggested.buzz;
                    feeImages = String(suggested.images);
                  }}
                >
                  Use this
                </button>
              </p>
              <span class="w-full text-xs text-dark-3">Leave empty to clear the fee.</span>
            </form>
          {:else}
            <span class="text-sm text-dark-1">{formatFeeRatio(editing.licensingFee)}</span>
          {/if}
        </section>

        {#key editing.id}
          <PaidAccessEditor
            version={editing}
            onClose={() => (editing = null)}
            maxEarlyAccessDays={data.maxEarlyAccessDays}
            canSellIndefinitely={data.canSellIndefinitely}
            permanentCap={data.permanentCap}
            permanentUsed={data.permanentUsed}
            earlyAccessUsed={data.earlyAccessUsed}
            earlyAccessCap={data.earlyAccessCap}
            tier={data.tier}
          />
        {/key}
      </div>
    {/if}
  </SheetContent>
</Sheet>
