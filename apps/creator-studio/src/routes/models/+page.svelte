<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
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
  import { IconSearch, IconFilter, IconArrowsSort } from '@tabler/icons-svelte';
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

  // Fee buzz/images fields accept whole positive integers only — reject any typed or pasted non-digit
  // (decimal point, sign, exponent, letters) before it lands in the value.
  function integerOnly(e: InputEvent) {
    const text = e.data ?? e.dataTransfer?.getData('text') ?? '';
    if (text && /\D/.test(text)) e.preventDefault();
  }

  // --- Bulk mode ---
  const bulkMode = $derived(data.canSetFee && page.url.searchParams.get('mode') === 'bulk');
  let selected = $state<Set<number>>(new Set());
  // Bulk editor defaults to 1 ⚡ per DEFAULT_FEE_IMAGES (10) images.
  let bulkBuzz = $state('1');
  let bulkImages = $state(String(DEFAULT_FEE_IMAGES));
  let showBulkConfirm = $state(false);
  let bulkForm = $state<HTMLFormElement>();

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
    if (event.result.type === 'success') toast.success('Licensing fee saved');
    else if (event.result.type === 'failure') toast.error(String(event.result.data?.error ?? 'Failed to save'));
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

  const filterActive = $derived(!!data.query.q || !!data.query.fee);

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
    ea = {
      timeframe: c?.timeframe ?? 7,
      chargeForDownload: c?.chargeForDownload ?? false,
      downloadPrice: c?.downloadPrice ?? MIN_DOWNLOAD_PRICE,
      chargeForGeneration: c?.chargeForGeneration ?? true,
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

<header class="page-header flex items-start gap-3">
  <div>
    <h1>Models</h1>
    <p>Set licensing fees, manage early/paid access, and sell access indefinitely — per version.</p>
  </div>
  {#if data.canSetFee && (data.total > 0 || bulkMode)}
    <a
      href={bulkMode ? '/models' : '/models?mode=bulk'}
      class="ml-auto rounded-md border border-dark-4 bg-dark-6 px-3 py-1.5 text-sm text-white hover:border-dark-3"
    >
      {bulkMode ? 'Done' : 'Bulk edit fees'}
    </a>
  {/if}
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
      class="rounded border border-dark-4 bg-dark-6 p-1.5 text-white hover:border-dark-3"
    >
      <IconSearch size={16} />
    </button>
  </form>
  <div class="flex items-center gap-1 rounded border border-dark-4 bg-dark-7 pl-2" title="Filter">
    <IconFilter size={16} class="text-dark-3" />
    <select
      aria-label="Filter by fee"
      value={data.query.fee}
      onchange={(e) => navigate({ fee: e.currentTarget.value || null, page: null })}
      class="bg-transparent py-1.5 pr-2 text-sm text-white outline-none"
    >
      <option value="">All fees</option>
      <option value="set">Has a fee</option>
      <option value="off">No fee</option>
    </select>
  </div>
  <div class="flex items-center gap-1 rounded border border-dark-4 bg-dark-7 pl-2" title="Sort">
    <IconArrowsSort size={16} class="text-dark-3" />
    <select
      aria-label="Sort"
      value={data.query.sort}
      onchange={(e) => navigate({ sort: e.currentTarget.value, page: null })}
      class="bg-transparent py-1.5 pr-2 text-sm text-white outline-none"
    >
      <option value="recent">Recently updated</option>
      <option value="name">Name</option>
    </select>
  </div>
  <span class="ml-auto text-xs text-dark-3">{data.total} model{data.total === 1 ? '' : 's'}</span>
</div>

{#if bulkMode && selected.size > 0}
  <div
    class="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-8/40 bg-dark-6 p-3 shadow-lg"
  >
    <span class="text-sm font-medium text-white">{selected.size} selected</span>
    <form bind:this={bulkForm} method="POST" action="?/bulkSetFee" use:enhance={bulkEnhance} class="contents">
      <input type="hidden" name="versionIds" value={[...selected].join(',')} />
      <input
        type="number"
        name="buzz"
        min="0"
        step="1"
        inputmode="numeric"
        onbeforeinput={integerOnly}
        bind:value={bulkBuzz}
        placeholder="Buzz"
        aria-label="Buzz (leave empty to clear the fee)"
        title="Leave empty to clear the fee"
        class="w-20 rounded border border-dark-4 bg-dark-7 px-2 py-1 text-sm text-white"
      />
      <span class="text-sm text-dark-3">⚡ per</span>
      <select
        name="images"
        bind:value={bulkImages}
        aria-label="Images"
        class="rounded border border-dark-4 bg-dark-7 px-1.5 py-1 text-sm text-white"
      >
        {#each FEE_IMAGE_OPTIONS as opt (opt)}
          <option value={String(opt)}>{opt}</option>
        {/each}
      </select>
      <span class="text-sm text-dark-3">images</span>
      <button
        type="button"
        onclick={() => (showBulkConfirm = true)}
        class="rounded bg-blue-8 px-3 py-1 text-sm font-medium text-white hover:bg-blue-7"
      >
        Apply to {selected.size}
      </button>
      <button
        type="submit"
        formaction="?/bulkApplyDefault"
        class="rounded border border-dark-4 px-3 py-1 text-sm text-white hover:border-dark-3"
        title="Set each selected version to its model-type default (LoRA 1 ⚡ per 10 images, Checkpoint 1 ⚡ per image)"
      >
        Apply default by type
      </button>
      <span class="text-xs text-dark-3">Empty buzz clears the fee.</span>
    </form>
  </div>
{/if}

{#if data.models.length === 0}
  <div class="placeholder">
    {#if filterActive}
      No models match your filters. <button class="underline" onclick={() => navigate({ q: null, fee: null, page: null })}>Clear</button>
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
              <input
                type="checkbox"
                checked={allSelected(model)}
                onchange={() => toggleModel(model)}
                aria-label="Select all versions of {model.name}"
                class="size-4"
              />
            {/if}
            <CardTitle class="text-base text-white">{model.name}</CardTitle>
            <Badge variant="secondary">{model.type}</Badge>
            <Badge variant={model.status === 'Published' ? 'default' : 'outline'} class="ml-auto">
              {model.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {#if model.versions.length === 0}
            <p class="text-sm text-dark-3">No versions.</p>
          {:else}
            <Table>
              <TableHeader>
                <TableRow>
                  {#if bulkMode}<TableHead class="w-8"></TableHead>{/if}
                  <TableHead>Version</TableHead>
                  <TableHead>Base model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Licensing fee</TableHead>
                  <TableHead>Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each model.versions as version (version.id)}
                  {@const st = feeStatus(version.licensingFee)}
                  {@const ratio = feeToRatio(version.licensingFee)}
                  <TableRow>
                    {#if bulkMode}
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selected.has(version.id)}
                          onchange={() => toggleVersion(version.id)}
                          aria-label="Select {version.name}"
                          class="size-4"
                        />
                      </TableCell>
                    {/if}
                    <TableCell class="font-medium text-white">{version.name}</TableCell>
                    <TableCell class="text-dark-2">{version.baseModel}</TableCell>
                    <TableCell>
                      <Badge variant={version.status === 'Published' ? 'default' : 'outline'}>
                        {version.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div class="flex items-center gap-2">
                        {#if data.canSetFee && !bulkMode}
                          <form method="POST" action="?/setFee" use:enhance={setFeeEnhance} class="flex items-center gap-1.5">
                            <input type="hidden" name="versionId" value={version.id} />
                            <input
                              type="number"
                              name="buzz"
                              min="0"
                              step="1"
                              inputmode="numeric"
                              onbeforeinput={integerOnly}
                              value={ratio.buzz || ''}
                              placeholder="Off"
                              aria-label="Buzz for {version.name}"
                              class="w-14 rounded border border-dark-4 bg-dark-7 px-2 py-1 text-sm text-white"
                            />
                            <span class="text-xs text-dark-3">⚡ per</span>
                            <select
                              name="images"
                              value={String(ratio.images)}
                              aria-label="Images for {version.name}"
                              class="rounded border border-dark-4 bg-dark-7 px-1.5 py-1 text-sm text-white"
                            >
                              {#each FEE_IMAGE_OPTIONS as opt (opt)}
                                <option value={String(opt)}>{opt}</option>
                              {/each}
                            </select>
                            <span class="text-xs text-dark-3">images</span>
                            <button
                              type="submit"
                              class="rounded bg-blue-8 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-7"
                            >
                              Save
                            </button>
                          </form>
                        {:else}
                          <span class="text-dark-1">{formatFeeRatio(version.licensingFee)}</span>
                        {/if}
                        <span class="text-xs {st.cls}">{st.label}</span>
                      </div>
                    </TableCell>
                    <TableCell class="text-dark-2">
                      <div class="flex items-center gap-2">
                        <span>{version.hasEarlyAccess ? 'Early access' : '—'}</span>
                        {#if !bulkMode}
                          <button
                            type="button"
                            onclick={() => openEditor(version)}
                            class="rounded border border-dark-4 px-2 py-0.5 text-xs text-white hover:border-dark-3"
                          >
                            {version.earlyAccessConfig ? 'Edit' : 'Set up'}
                          </button>
                        {/if}
                      </div>
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          {/if}
        </CardContent>
      </Card>
    {/each}
  </div>

  {#if data.pageCount > 1}
    <div class="mt-6 flex items-center justify-center gap-4 text-sm">
      <button
        disabled={data.page <= 1}
        onclick={() => navigate({ page: String(data.page - 1) })}
        class="rounded border border-dark-4 px-3 py-1 text-white disabled:opacity-40 hover:border-dark-3"
      >
        Previous
      </button>
      <span class="text-dark-2">Page {data.page} of {data.pageCount}</span>
      <button
        disabled={data.page >= data.pageCount}
        onclick={() => navigate({ page: String(data.page + 1) })}
        class="rounded border border-dark-4 px-3 py-1 text-white disabled:opacity-40 hover:border-dark-3"
      >
        Next
      </button>
    </div>
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
      <SheetHeader class="border-b border-dark-4 p-5">
        <SheetTitle class="text-white">Early &amp; paid access</SheetTitle>
        <SheetDescription>
          {editing.name} — gate this version behind payment for a limited time. When the window ends it becomes
          free and public.
        </SheetDescription>
      </SheetHeader>

      <form method="POST" action="?/setEarlyAccess" use:enhance={eaEnhance} class="flex flex-col gap-5 p-5">
        <input type="hidden" name="versionId" value={editing.id} />

        <label class="flex flex-col gap-1 text-sm">
          <span class="text-dark-1">Early access duration (days)</span>
          <input
            type="number"
            name="timeframe"
            min="1"
            bind:value={ea.timeframe}
            class="w-32 rounded border border-dark-4 bg-dark-7 px-2 py-1.5 text-white"
          />
        </label>

        <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
          <label class="flex items-center gap-2 text-sm text-white">
            <input type="checkbox" name="chargeForDownload" bind:checked={ea.chargeForDownload} class="size-4" />
            Charge to download
          </label>
          {#if ea.chargeForDownload}
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-dark-2">Download price (⚡, min {MIN_DOWNLOAD_PRICE})</span>
              <input
                type="number"
                name="downloadPrice"
                min={MIN_DOWNLOAD_PRICE}
                bind:value={ea.downloadPrice}
                class="w-40 rounded border border-dark-4 bg-dark-7 px-2 py-1.5 text-white"
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
              <input
                type="number"
                name="generationPrice"
                min={MIN_GENERATION_PRICE}
                bind:value={ea.generationPrice}
                class="w-40 rounded border border-dark-4 bg-dark-7 px-2 py-1.5 text-white"
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-dark-2">Free trial generations (0–{MAX_GENERATION_TRIAL_LIMIT})</span>
              <input
                type="number"
                name="generationTrialLimit"
                min="0"
                max={MAX_GENERATION_TRIAL_LIMIT}
                bind:value={ea.generationTrialLimit}
                class="w-32 rounded border border-dark-4 bg-dark-7 px-2 py-1.5 text-white"
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
              <input
                type="number"
                name="donationGoal"
                min="0"
                bind:value={ea.donationGoal}
                class="w-40 rounded border border-dark-4 bg-dark-7 px-2 py-1.5 text-white"
              />
            </label>
          {/if}
        </div>

        {#if !ea.chargeForDownload && !ea.chargeForGeneration}
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
  </SheetContent>
</Sheet>
