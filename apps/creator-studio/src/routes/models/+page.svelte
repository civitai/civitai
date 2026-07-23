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
    MIN_DOWNLOAD_PRICE,
    MIN_GENERATION_PRICE,
    DEFAULT_GENERATION_TRIAL_LIMIT,
    MAX_GENERATION_TRIAL_LIMIT,
  } from '$lib/monetization/early-access';
  import {
    feeToRatio,
    formatFeeRatio,
    suggestedFeePerImage,
    FEE_IMAGE_OPTIONS,
    DEFAULT_FEE_IMAGES,
  } from '$lib/monetization/fee';
  import JoinUpsell from '$lib/components/JoinUpsell.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
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
  // A reactive Set — in-place add/delete/clear stay fine-grained (no reassign-to-mutate).
  const selected = new SvelteSet<number>();
  // Bulk editor defaults to 1 ⚡ per DEFAULT_FEE_IMAGES (10) images.
  let bulkBuzz = $state<number | undefined>(1);
  let bulkImages = $state(String(DEFAULT_FEE_IMAGES));
  let showBulkConfirm = $state(false);
  let bulkForm = $state<HTMLFormElement>();
  // The suggested fee is per model type, so surface a bulk "use suggested" only when the type filter pins one.
  const bulkSuggested = $derived(data.query.mt ? suggestedFeePerImage(data.query.mt) : undefined);

  // Leaving bulk mode (Cancel, or any URL change that drops ?mode=bulk) discards a pending selection.
  $effect(() => {
    if (!bulkMode && selected.size > 0) selected.clear();
  });

  function toggleVersion(id: number) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
  function allSelected(model: CreatorModel) {
    return model.versions.length > 0 && model.versions.every((v) => selected.has(v.id));
  }
  function toggleModel(model: CreatorModel) {
    const all = allSelected(model);
    for (const v of model.versions) {
      if (all) selected.delete(v.id);
      else selected.add(v.id);
    }
  }
  function selectAll(ids: number[]) {
    selected.clear();
    for (const id of ids) selected.add(id);
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

  const bulkEnhance = () => async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
    await event.update({ reset: false });
    if (event.result.type === 'success') {
      const n = Number(event.result.data?.updated ?? 0);
      toast.success(`Updated ${n} version${n === 1 ? '' : 's'}`);
      selected.clear();
    } else if (event.result.type === 'failure') {
      toast.error(String(event.result.data?.error ?? 'Failed'));
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
  let ea = $state({
    timeframe: 7,
    permanent: false,
    chargeForDownload: false,
    downloadPrice: MIN_DOWNLOAD_PRICE,
    chargeForGeneration: true,
    generationPrice: MIN_GENERATION_PRICE,
    generationTrialLimit: DEFAULT_GENERATION_TRIAL_LIMIT,
    donationGoalEnabled: false,
    donationGoal: undefined as number | undefined,
    freeGeneration: false,
  });

  function openEditor(version: CreatorModelVersion, modelType: string) {
    editingType = modelType;
    const r = feeToRatio(version.licensingFee);
    feeBuzz = r.buzz || undefined;
    feeImages = String(r.images);
    const c = version.earlyAccessConfig;
    // Clamp the seeded duration to the creator's score-based max so the field starts in-range.
    const maxDays = data.maxEarlyAccessDays;
    ea = {
      timeframe: Math.min(c?.timeframe ?? 7, maxDays || Infinity),
      permanent: c?.permanent ?? false,
      chargeForDownload: c?.chargeForDownload ?? false,
      downloadPrice: c?.downloadPrice ?? MIN_DOWNLOAD_PRICE,
      chargeForGeneration: c?.chargeForGeneration ?? false,
      generationPrice: c?.generationPrice ?? MIN_GENERATION_PRICE,
      generationTrialLimit: c?.generationTrialLimit ?? DEFAULT_GENERATION_TRIAL_LIMIT,
      donationGoalEnabled: c?.donationGoalEnabled ?? false,
      donationGoal: c?.donationGoal,
      freeGeneration: c?.freeGeneration ?? false,
    };
    editing = version;
  }

  const eaEnhance = () => async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
    await event.update({ reset: false });
    if (event.result.type === 'success') {
      toast.success(event.result.data?.earlyAccessCleared ? 'Early access turned off' : 'Early access saved');
      editing = null;
      await invalidateAll();
    } else if (event.result.type === 'failure') {
      toast.error(String(event.result.data?.error ?? 'Failed to save early access'));
    }
  };
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
  {#if data.total > 0 && !bulkMode}
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
  <div
    class="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-8/40 bg-dark-6 p-3 shadow-lg"
  >
    <span class="text-sm font-medium text-white">
      {selected.size > 0 ? `${selected.size} selected` : 'Select versions to edit'}
    </span>
    {#if data.matchingVersionIds.length > 0}
      <Button
        variant="outline"
        size="sm"
        onclick={() => selectAll(data.matchingVersionIds)}
        title="Select every version matching the current filters (all pages)"
      >
        Select all {data.matchingVersionIds.length}
      </Button>
    {/if}
    {#if selected.size > 0}
      <Button variant="outline" size="sm" onclick={() => selected.clear()}>Clear</Button>
    {/if}
    <form bind:this={bulkForm} method="POST" action="?/bulkSetFee" use:enhance={bulkEnhance} class="contents">
      <input type="hidden" name="versionIds" value={[...selected].join(',')} />
      <NumberInput
        name="buzz"
        min={0}
        bind:value={bulkBuzz}
        placeholder="Buzz"
        aria-label="Buzz (leave empty to clear the fee)"
        title="Leave empty to clear the fee"
        class="h-7 w-20"
      />
      <span class="text-sm text-dark-1">⚡ per</span>
      <input type="hidden" name="images" value={bulkImages} />
      <Select.Root type="single" value={bulkImages} onValueChange={(v: string) => { if (v) bulkImages = v; }}>
        <Select.Trigger size="sm" class="w-16 text-white" aria-label="Images">
          {bulkImages}
        </Select.Trigger>
        <Select.Content>
          {#each FEE_IMAGE_OPTIONS as opt (opt)}
            <Select.Item value={String(opt)} label={String(opt)} />
          {/each}
        </Select.Content>
      </Select.Root>
      <span class="text-sm text-dark-1">images</span>
      <Button
        size="sm"
        disabled={selected.size === 0}
        onclick={() => (showBulkConfirm = true)}
      >
        Apply{selected.size > 0 ? ` to ${selected.size}` : ''}
      </Button>
      <Button href={buildHref({ mode: null })} data-sveltekit-replacestate variant="outline" size="sm">
        Cancel
      </Button>
      {#if bulkSuggested !== undefined}
        {@const sr = feeToRatio(bulkSuggested)}
        <button
          type="button"
          class="text-xs text-dark-1 hover:text-white hover:underline"
          onclick={() => {
            bulkBuzz = sr.buzz;
            bulkImages = String(sr.images);
          }}
        >
          Use suggested ({formatFeeRatio(bulkSuggested)})
        </button>
      {/if}
      <span class="text-xs text-dark-1">Empty buzz clears the fee.</span>
    </form>
  </div>
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
            {#if bulkMode && model.versions.length > 0}
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
            {#if !bulkMode}
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
                  {#if bulkMode}
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
                        {#if version.hasEarlyAccess}
                          <Badge variant="outline" class={eaChipCls} title="Early access is on">
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

<AlertDialog bind:open={showBulkConfirm}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Apply fee to {selected.size} version{selected.size === 1 ? '' : 's'}?</AlertDialogTitle>
      <AlertDialogDescription>
        This changes what creators are charged to generate with these versions. An empty value clears the fee.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onclick={() => {
          showBulkConfirm = false;
          bulkForm?.requestSubmit();
        }}>Apply</AlertDialogAction
      >
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>

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

        <!-- Early & paid access -->
        <section class="flex flex-col gap-4 border-t border-dark-4 pt-6">
          <div class="flex flex-col gap-1">
            <span class="text-sm font-medium text-white">Early &amp; paid access</span>
            <span class="text-xs text-dark-2">
              Gate this version behind payment for a limited time. When the window ends it becomes free and public.
            </span>
          </div>

          {#if data.maxEarlyAccessDays === 0}
            <p class="rounded-lg border border-dark-4 p-3 text-xs text-dark-2">
              Early access isn't available for your account yet — it unlocks as your creator score grows.
            </p>
          {:else}
            <form method="POST" action="?/setEarlyAccess" use:enhance={eaEnhance} class="flex flex-col gap-4">
              <input type="hidden" name="versionId" value={editing.id} />

              {#if data.canSellIndefinitely}
                <div class="flex flex-col gap-1 rounded-lg border border-dark-4 p-3">
                  <div class="flex items-center gap-2">
                    <Checkbox id="ea-perm" name="permanent" bind:checked={ea.permanent} />
                    <Label for="ea-perm" class="cursor-pointer text-sm font-normal text-white">
                      Make permanent (no end date)
                    </Label>
                  </div>
                  <span class="text-xs text-dark-3">
                    Members-only. Access never expires until you turn it off; buyers keep what they paid for.
                  </span>
                </div>
              {/if}

              {#if ea.permanent}
                <input type="hidden" name="timeframe" value="0" />
              {:else}
                <label class="flex flex-col gap-1 text-sm">
                  <span class="text-dark-1">Early access duration (days)</span>
                  <NumberInput
                    name="timeframe"
                    min={0}
                    max={data.maxEarlyAccessDays}
                    bind:value={ea.timeframe}
                    class="w-32"
                  />
                  <span class="text-xs text-dark-3">
                    Up to {data.maxEarlyAccessDays} day{data.maxEarlyAccessDays === 1 ? '' : 's'} at your creator level — set 0 to turn early access off.
                  </span>
                </label>
              {/if}

              <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
                <div class="flex items-center gap-2">
                  <Checkbox id="ea-cd" name="chargeForDownload" bind:checked={ea.chargeForDownload} />
                  <Label for="ea-cd" class="cursor-pointer text-sm font-normal text-white">Charge to download</Label>
                </div>
                {#if ea.chargeForDownload}
                  <label class="flex flex-col gap-1 text-sm">
                    <span class="text-dark-2">Download price (⚡, min {MIN_DOWNLOAD_PRICE})</span>
                    <NumberInput
                      name="downloadPrice"
                      min={MIN_DOWNLOAD_PRICE}
                      bind:value={ea.downloadPrice}
                      class="w-40"
                    />
                  </label>
                {/if}
              </div>

              <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
                <div class="flex items-center gap-2">
                  <Checkbox id="ea-cg" name="chargeForGeneration" bind:checked={ea.chargeForGeneration} />
                  <Label for="ea-cg" class="cursor-pointer text-sm font-normal text-white">Charge to generate</Label>
                </div>
                {#if ea.chargeForGeneration}
                  <label class="flex flex-col gap-1 text-sm">
                    <span class="text-dark-2">Generation price (⚡, min {MIN_GENERATION_PRICE})</span>
                    <NumberInput
                      name="generationPrice"
                      min={MIN_GENERATION_PRICE}
                      bind:value={ea.generationPrice}
                      class="w-40"
                    />
                  </label>
                  <label class="flex flex-col gap-1 text-sm">
                    <span class="text-dark-2">Free trial generations (0–{MAX_GENERATION_TRIAL_LIMIT})</span>
                    <NumberInput
                      name="generationTrialLimit"
                      min={0}
                      max={MAX_GENERATION_TRIAL_LIMIT}
                      bind:value={ea.generationTrialLimit}
                      class="w-32"
                    />
                  </label>
                  <div class="flex items-center gap-2">
                    <Checkbox id="ea-fg" name="freeGeneration" bind:checked={ea.freeGeneration} />
                    <Label for="ea-fg" class="cursor-pointer text-sm font-normal text-white">Allow free generation</Label>
                  </div>
                {/if}
              </div>

              <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
                <div class="flex items-center gap-2">
                  <Checkbox id="ea-dg" name="donationGoalEnabled" bind:checked={ea.donationGoalEnabled} />
                  <Label for="ea-dg" class="cursor-pointer text-sm font-normal text-white">Enable a donation goal</Label>
                </div>
                {#if ea.donationGoalEnabled}
                  <label class="flex flex-col gap-1 text-sm">
                    <span class="text-dark-2">Goal amount (⚡)</span>
                    <NumberInput name="donationGoal" min={0} bind:value={ea.donationGoal} class="w-40" />
                  </label>
                {/if}
              </div>

              {#if ea.permanent}
                {#if !ea.chargeForDownload && !ea.chargeForGeneration}
                  <p class="text-xs text-yellow-5">
                    Enable a download or generation charge — permanent access needs a price.
                  </p>
                {/if}
              {:else if !ea.timeframe}
                <p class="text-xs text-dark-3">A duration of 0 turns early access off when you save.</p>
              {:else if !ea.chargeForDownload && !ea.chargeForGeneration}
                <p class="text-xs text-yellow-5">Enable a download or generation charge to turn on early access.</p>
              {/if}

              <SheetFooter class="flex-col gap-2 p-0">
                <Button type="submit">Save early access</Button>
                {#if editing.earlyAccessConfig}
                  <Button type="submit" name="clear" value="true" variant="outline">
                    Turn off early access
                  </Button>
                {/if}
              </SheetFooter>
            </form>
          {/if}
        </section>
      </div>
    {/if}
  </SheetContent>
</Sheet>
