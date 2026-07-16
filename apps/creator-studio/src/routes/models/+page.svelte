<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
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
  import {
    MIN_DOWNLOAD_PRICE,
    MIN_GENERATION_PRICE,
    DEFAULT_GENERATION_TRIAL_LIMIT,
    MAX_GENERATION_TRIAL_LIMIT,
  } from '$lib/monetization/early-access';
  import {
    feeToRatio,
    formatFeeRatio,
    FEE_IMAGE_OPTIONS,
    DEFAULT_FEE_IMAGES,
  } from '$lib/monetization/fee';
  import JoinUpsell from '$lib/components/JoinUpsell.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import {
    IconSearch,
    IconFilter,
    IconArrowsSort,
    IconChevronRight,
    IconExternalLink,
  } from '@tabler/icons-svelte';
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
      (data.query.access ? 1 : 0) +
      (data.query.fee ? 1 : 0)
  );

  // --- URL-driven table state (search / fee filter / sort / pagination) ---
  function navigate(params: Record<string, string | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    goto(url, { keepFocus: true, noScroll: true });
  }

  // Search fires on Enter, on blur, and via the button — all no-op if the term is unchanged.
  function runSearch(raw: FormDataEntryValue | string | null) {
    const q = String(raw ?? '').trim();
    if (q === (data.query.q ?? '')) return;
    navigate({ q: q || null, page: null });
  }

  // Windowed page numbers (M1): always the first + last page, plus a ±2 window around the current one, with 'gap'
  // markers collapsed to an ellipsis. So a creator with many pages can jump anywhere, not just one at a time.
  function pageNumbers(current: number, count: number): (number | 'gap')[] {
    const keep = new Set<number>([1, count]);
    for (let i = current - 2; i <= current + 2; i++) if (i >= 1 && i <= count) keep.add(i);
    const nums = [...keep].sort((a, b) => a - b);
    const out: (number | 'gap')[] = [];
    let prev = 0;
    for (const n of nums) {
      if (prev && n - prev > 1) out.push('gap');
      out.push(n);
      prev = n;
    }
    return out;
  }

  // --- Bulk mode ---
  const bulkMode = $derived(data.canSetFee && page.url.searchParams.get('mode') === 'bulk');
  let selected = $state<Set<number>>(new Set());
  // Bulk editor defaults to 1 ⚡ per DEFAULT_FEE_IMAGES (10) images.
  let bulkBuzz = $state<number | undefined>(1);
  let bulkImages = $state(String(DEFAULT_FEE_IMAGES));
  let showBulkConfirm = $state(false);
  let bulkForm = $state<HTMLFormElement>();

  // Leaving bulk mode (Done, browser back, or any URL change) discards a pending selection.
  $effect(() => {
    if (!bulkMode && selected.size > 0) selected = new Set();
  });

  function toggleVersion(id: number) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    selected = next;
  }
  function allSelected(model: CreatorModel) {
    return model.versions.length > 0 && model.versions.every((v) => selected.has(v.id));
  }
  function toggleModel(model: CreatorModel) {
    const next = new Set(selected);
    const all = allSelected(model);
    for (const v of model.versions) all ? next.delete(v.id) : next.add(v.id);
    selected = next;
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

  const bulkEnhance = () => async (event: { result: any; update: (o?: { reset?: boolean }) => Promise<void> }) => {
    await event.update({ reset: false });
    if (event.result.type === 'success') {
      const n = Number(event.result.data?.updated ?? 0);
      toast.success(`Updated ${n} version${n === 1 ? '' : 's'}`);
      selected = new Set();
    } else if (event.result.type === 'failure') {
      toast.error(String(event.result.data?.error ?? 'Failed'));
    }
  };

  const filterActive = $derived(
    !!data.query.q || !!data.query.fee || !!data.query.bm || !!data.query.status || data.query.access
  );

  // --- Early/paid-access editor (per-version drawer) ---
  let editing = $state<CreatorModelVersion | null>(null);
  let ea = $state({
    timeframe: 7,
    chargeForDownload: false,
    downloadPrice: MIN_DOWNLOAD_PRICE,
    chargeForGeneration: true,
    generationPrice: MIN_GENERATION_PRICE,
    generationTrialLimit: DEFAULT_GENERATION_TRIAL_LIMIT,
    donationGoalEnabled: false,
    donationGoal: undefined as number | undefined,
    freeGeneration: false,
  });

  function openEditor(version: CreatorModelVersion) {
    const c = version.earlyAccessConfig;
    // Clamp the seeded duration to the creator's score-based max so the field starts in-range.
    const maxDays = data.maxEarlyAccessDays;
    ea = {
      timeframe: Math.min(c?.timeframe ?? 7, maxDays || Infinity),
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
  <h1>Models</h1>
  <p>Set licensing fees, manage early/paid access, and sell access indefinitely — per version.</p>
</header>

{#if !data.canSetFee}
  <JoinUpsell
    class="mb-6"
    body="Setting licensing fees requires Creator Program membership. You can still review your models below."
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
    <input
      name="q"
      value={data.query.q}
      placeholder="Search models…"
      onblur={(e) => runSearch(e.currentTarget.value)}
      class="w-56 rounded border border-dark-4 bg-dark-7 px-2 py-1.5 text-sm text-white"
    />
    <button
      type="submit"
      aria-label="Search"
      title="Search"
      class="flex items-center justify-center rounded border border-dark-4 bg-dark-6 px-2.5 py-2 text-white hover:border-dark-3"
    >
      <IconSearch size={16} />
    </button>
  </form>
  <Popover.Root>
    <Popover.Trigger
      class="flex items-center gap-1.5 rounded border border-dark-4 bg-dark-7 px-2.5 py-1.5 text-sm text-white hover:border-dark-3"
    >
      <IconFilter size={16} class="text-dark-3" />
      Filters
      {#if activeFilterCount > 0}
        <span class="rounded-full bg-blue-8 px-1.5 text-xs font-medium text-white">{activeFilterCount}</span>
      {/if}
    </Popover.Trigger>
    <Popover.Content class="w-64 space-y-4 border-dark-4 bg-dark-7 p-4 text-sm text-white">
      <fieldset class="space-y-1.5">
        <legend class="mb-1 text-xs font-medium uppercase tracking-wide text-dark-3">Status</legend>
        {#each statusOptions as opt (opt.value)}
          <label class="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="status"
              checked={(data.query.status ?? '') === opt.value}
              onchange={() => navigate({ status: opt.value || null, page: null })}
            />
            {opt.label}
          </label>
        {/each}
      </fieldset>
      <div class="space-y-1">
        <label for="filter-bm" class="text-xs font-medium uppercase tracking-wide text-dark-3">Base model</label>
        <select
          id="filter-bm"
          value={data.query.bm}
          onchange={(e) => navigate({ bm: e.currentTarget.value || null, page: null })}
          class="w-full rounded border border-dark-4 bg-dark-6 px-2 py-1.5 text-sm text-white [&>option]:bg-dark-7"
        >
          <option value="">All base models</option>
          {#each data.baseModels as bm (bm)}
            <option value={bm}>{bm}</option>
          {/each}
        </select>
      </div>
      <label class="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={data.query.access}
          onchange={(e) => navigate({ access: e.currentTarget.checked ? '1' : null, page: null })}
        />
        Has early / paid access
      </label>
      <fieldset class="space-y-1.5">
        <legend class="mb-1 text-xs font-medium uppercase tracking-wide text-dark-3">Licensing fee</legend>
        {#each feeOptions as opt (opt.value)}
          <label class="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="fee"
              checked={(data.query.fee ?? '') === opt.value}
              onchange={() => navigate({ fee: opt.value || null, page: null })}
            />
            {opt.label}
          </label>
        {/each}
      </fieldset>
      {#if activeFilterCount > 0}
        <button
          type="button"
          onclick={() => navigate({ status: null, bm: null, access: null, fee: null, page: null })}
          class="text-xs text-blue-4 hover:underline"
        >
          Clear filters
        </button>
      {/if}
    </Popover.Content>
  </Popover.Root>
  <div class="flex items-center gap-1 rounded border border-dark-4 bg-dark-7 pl-2" title="Sort">
    <IconArrowsSort size={16} class="text-dark-3" />
    <select
      aria-label="Sort"
      value={data.query.sort}
      onchange={(e) => navigate({ sort: e.currentTarget.value, page: null })}
      class="bg-transparent py-1.5 pr-2 text-sm text-white outline-none [&>option]:bg-dark-7 [&>option]:text-white"
    >
      <option value="recent">Recently updated</option>
      <option value="name">Name</option>
    </select>
  </div>
  {#if data.canSetFee && data.total > 0 && !bulkMode}
    <a
      href="/models?mode=bulk"
      class="ml-auto rounded-md border border-dark-4 bg-dark-6 px-3 py-1.5 text-sm text-white hover:border-dark-3"
    >
      Bulk edit fees
    </a>
  {/if}
</div>

<p class="mb-4 text-xs text-dark-3">{data.total} model{data.total === 1 ? '' : 's'}</p>

{#if bulkMode}
  <div
    class="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-8/40 bg-dark-6 p-3 shadow-lg"
  >
    <span class="text-sm font-medium text-white">
      {selected.size > 0 ? `${selected.size} selected` : 'Select versions to edit'}
    </span>
    {#if data.matchingVersionIds.length > 0}
      <button
        type="button"
        onclick={() => (selected = new Set(data.matchingVersionIds))}
        title="Select every version matching the current filters (all pages)"
        class="rounded border border-dark-4 px-2 py-1 text-xs text-white hover:border-dark-3"
      >
        Select all {data.matchingVersionIds.length}
      </button>
    {/if}
    {#if selected.size > 0}
      <button
        type="button"
        onclick={() => (selected = new Set())}
        class="rounded border border-dark-4 px-2 py-1 text-xs text-white hover:border-dark-3"
      >
        Clear
      </button>
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
        class="w-20 py-1"
      />
      <span class="text-sm text-dark-1">⚡ per</span>
      <select
        name="images"
        bind:value={bulkImages}
        aria-label="Images"
        class="rounded border border-dark-4 bg-dark-7 px-1.5 py-1 text-sm text-white [&>option]:bg-dark-7 [&>option]:text-white"
      >
        {#each FEE_IMAGE_OPTIONS as opt (opt)}
          <option value={String(opt)}>{opt}</option>
        {/each}
      </select>
      <span class="text-sm text-dark-1">images</span>
      <button
        type="button"
        disabled={selected.size === 0}
        onclick={() => (showBulkConfirm = true)}
        class="rounded bg-blue-8 px-3 py-1 text-sm font-medium text-white hover:bg-blue-7 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Apply{selected.size > 0 ? ` to ${selected.size}` : ''}
      </button>
      <a
        href="/models"
        class="inline-flex items-center rounded border border-dark-4 px-3 py-1 text-sm text-white hover:border-dark-3"
      >
        Cancel
      </a>
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
              <label class="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={allSelected(model)}
                  onchange={() => toggleModel(model)}
                  aria-label="Select all versions of {model.name}"
                  class="size-4"
                />
                <CardTitle class="text-base text-white">{model.name}</CardTitle>
              </label>
            {:else}
              <CardTitle class="text-base text-white">{model.name}</CardTitle>
            {/if}
            <Badge variant="secondary">{model.type}</Badge>
            <Badge variant={model.status === 'Published' ? 'default' : 'outline'} class="ml-auto">
              {model.status}
            </Badge>
            {#if !bulkMode}
              <a
                href="https://civitai.com/models/{model.id}"
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
                    <label class="flex w-full cursor-pointer items-center gap-3 px-5 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(version.id)}
                        onchange={() => toggleVersion(version.id)}
                        aria-label="Select {version.name}"
                        class="size-4 shrink-0"
                      />
                      <span class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <span class="truncate text-sm font-medium text-white">{version.name}</span>
                        <span
                          class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide {statusBadgeCls(
                            version.status
                          )}"
                        >
                          {version.status}
                        </span>
                        <span
                          class="shrink-0 rounded border border-dark-4 bg-dark-6 px-1.5 py-0.5 text-[10px] font-medium text-dark-2"
                        >
                          {version.baseModel}
                        </span>
                      </span>
                      <span
                        class="shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium {chip.cls}"
                      >
                        {chip.label}
                      </span>
                    </label>
                  {:else}
                    <button
                      type="button"
                      onclick={() => openEditor(version)}
                      class="flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left hover:bg-dark-6/40"
                    >
                      <span class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <span class="truncate text-sm font-medium text-white">{version.name}</span>
                        <span
                          class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide {statusBadgeCls(
                            version.status
                          )}"
                        >
                          {version.status}
                        </span>
                        <span
                          class="shrink-0 rounded border border-dark-4 bg-dark-6 px-1.5 py-0.5 text-[10px] font-medium text-dark-2"
                        >
                          {version.baseModel}
                        </span>
                      </span>
                      <span class="flex shrink-0 items-center gap-2">
                        {#if version.hasEarlyAccess}
                          <span
                            title="Early access is on"
                            class="rounded-full border px-2 py-0.5 text-xs font-medium {eaChipCls}"
                          >
                            Early access
                          </span>
                        {/if}
                        <span class="rounded-full border px-2 py-0.5 text-xs font-medium {chip.cls}">
                          {chip.label}
                        </span>
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
    {@const btn =
      'flex h-8 min-w-8 items-center justify-center rounded border border-dark-4 px-2 text-white hover:border-dark-3 disabled:cursor-not-allowed disabled:opacity-40'}
    <nav class="mt-6 flex items-center justify-center gap-1 text-sm" aria-label="Pagination">
      <button disabled={data.page <= 1} onclick={() => navigate({ page: '1' })} class={btn} aria-label="First page">
        «
      </button>
      <button
        disabled={data.page <= 1}
        onclick={() => navigate({ page: String(data.page - 1) })}
        class={btn}
        aria-label="Previous page"
      >
        ‹
      </button>
      {#each pageNumbers(data.page, data.pageCount) as p, i (p === 'gap' ? `gap-${i}` : p)}
        {#if p === 'gap'}
          <span class="px-1 text-dark-3">…</span>
        {:else}
          <button
            onclick={() => navigate({ page: String(p) })}
            aria-label="Page {p}"
            aria-current={p === data.page ? 'page' : undefined}
            class="flex h-8 min-w-8 items-center justify-center rounded border px-2 {p === data.page
              ? 'border-blue-8 bg-blue-8 font-medium text-white'
              : 'border-dark-4 text-white hover:border-dark-3'}"
          >
            {p}
          </button>
        {/if}
      {/each}
      <button
        disabled={data.page >= data.pageCount}
        onclick={() => navigate({ page: String(data.page + 1) })}
        class={btn}
        aria-label="Next page"
      >
        ›
      </button>
      <button
        disabled={data.page >= data.pageCount}
        onclick={() => navigate({ page: String(data.pageCount) })}
        class={btn}
        aria-label="Last page"
      >
        »
      </button>
    </nav>
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

<Sheet open={editing != null} onOpenChange={(o) => { if (!o) editing = null; }}>
  <SheetContent side="right" class="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
    {#if editing}
      {@const ratio = feeToRatio(editing.licensingFee)}
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
            <form method="POST" action="?/setFee" use:enhance={setFeeEnhance} class="flex flex-wrap items-center gap-1.5">
              <input type="hidden" name="versionId" value={editing.id} />
              <NumberInput
                name="buzz"
                min={0}
                value={ratio.buzz || undefined}
                placeholder="Off"
                aria-label="Buzz for {editing.name}"
                class="w-16 py-1"
              />
              <span class="text-xs text-dark-3">⚡ per</span>
              <select
                name="images"
                value={String(ratio.images)}
                aria-label="Images for {editing.name}"
                class="rounded border border-dark-4 bg-dark-7 px-1.5 py-1 text-sm text-white"
              >
                {#each FEE_IMAGE_OPTIONS as opt (opt)}
                  <option value={String(opt)}>{opt}</option>
                {/each}
              </select>
              <span class="text-xs text-dark-3">images</span>
              <button
                type="submit"
                class="ml-auto rounded bg-blue-8 px-3 py-1 text-sm font-medium text-white hover:bg-blue-7"
              >
                Save fee
              </button>
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

              <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
                <label class="flex items-center gap-2 text-sm text-white">
                  <input type="checkbox" name="chargeForDownload" bind:checked={ea.chargeForDownload} class="size-4" />
                  Charge to download
                </label>
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
                <label class="flex items-center gap-2 text-sm text-white">
                  <input type="checkbox" name="chargeForGeneration" bind:checked={ea.chargeForGeneration} class="size-4" />
                  Charge to generate
                </label>
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
                  <label class="flex items-center gap-2 text-sm text-white">
                    <input type="checkbox" name="freeGeneration" bind:checked={ea.freeGeneration} class="size-4" />
                    Allow free generation
                  </label>
                {/if}
              </div>

              <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
                <label class="flex items-center gap-2 text-sm text-white">
                  <input type="checkbox" name="donationGoalEnabled" bind:checked={ea.donationGoalEnabled} class="size-4" />
                  Enable a donation goal
                </label>
                {#if ea.donationGoalEnabled}
                  <label class="flex flex-col gap-1 text-sm">
                    <span class="text-dark-2">Goal amount (⚡)</span>
                    <NumberInput name="donationGoal" min={0} bind:value={ea.donationGoal} class="w-40" />
                  </label>
                {/if}
              </div>

              {#if !ea.timeframe}
                <p class="text-xs text-dark-3">A duration of 0 turns early access off when you save.</p>
              {:else if !ea.chargeForDownload && !ea.chargeForGeneration}
                <p class="text-xs text-yellow-5">Enable a download or generation charge to turn on early access.</p>
              {/if}

              <SheetFooter class="flex-col gap-2 p-0">
                <button
                  type="submit"
                  class="rounded bg-blue-8 px-3 py-2 text-sm font-medium text-white hover:bg-blue-7"
                >
                  Save early access
                </button>
                {#if editing.earlyAccessConfig}
                  <button
                    type="submit"
                    name="clear"
                    value="true"
                    class="rounded border border-dark-4 px-3 py-2 text-sm text-white hover:border-dark-3"
                  >
                    Turn off early access
                  </button>
                {/if}
              </SheetFooter>
            </form>
          {/if}
        </section>
      </div>
    {/if}
  </SheetContent>
</Sheet>
