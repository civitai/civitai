<script lang="ts">
  import { browser } from '$app/environment';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import ModelCodeBadge from '$lib/components/ModelCodeBadge.svelte';
  import type { TrainingRow } from '$lib/data/trainingRows';
  import type { Media } from '$lib/data/trainingModels';
  import { toReuseItems } from '$lib/reuse';

  // Emits items in addFromBlobs shape so the Data step can seed them with no re-upload.
  let {
    open = $bindable(false),
    media,
    onReuse,
  }: {
    open: boolean;
    /** Only same-media runs are reusable — an image dataset can't seed an audio run, etc. */
    media: Media;
    onReuse: (items: { blobId: string; url: string; name: string; caption: string }[]) => void;
  } = $props();

  // Derive the fetch from `open` so the list re-loads each time it's opened; never rejects the panel.
  const trainings = $derived(
    browser && open
      ? fetch('/api/trainings').then((r) => r.json() as Promise<TrainingRow[]>)
      : null
  );

  let loadingId = $state<string | null>(null);
  let error = $state('');

  async function pick(row: TrainingRow) {
    if (!row.workflowId || loadingId) return;
    loadingId = row.workflowId;
    error = '';
    try {
      const res = await fetch(`/api/run-dataset?id=${encodeURIComponent(row.workflowId)}`);
      if (!res.ok) throw new Error('fetch failed');
      const dataset = (await res.json()) as { air: string; caption: string }[];
      if (dataset.length === 0) {
        error = "That run's dataset can't be reused (no per-image blobs).";
        return;
      }
      onReuse(
        toReuseItems(dataset, row.workflowId).map((i) => ({
          blobId: i.air,
          url: i.previewUrl,
          name: i.name,
          caption: i.caption,
        }))
      );
      open = false;
    } catch {
      error = "Couldn't load that dataset.";
    } finally {
      loadingId = null;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Reuse a dataset</Dialog.Title>
      <Dialog.Description>
        Pick an existing training to load its images + captions — no re-upload.
      </Dialog.Description>
    </Dialog.Header>

    {#if error}
      <p class="font-mono text-[11px] text-red-400">{error}</p>
    {/if}

    {#if trainings}
      {#await trainings}
        <div class="py-10 text-center font-mono text-sm text-dark-2">Loading your trainings…</div>
      {:then rows}
        {@const shown = rows.filter((r) => r.media === media)}
        {#if shown.length === 0}
          <div class="py-10 text-center font-mono text-sm text-dark-2">
            No {media} trainings to reuse yet.
          </div>
        {:else}
          <div class="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {#each shown as row (row.workflowId)}
              <button
                type="button"
                onclick={() => pick(row)}
                disabled={loadingId != null}
                class="flex items-center gap-3 rounded-lg border border-dark-4 bg-dark-6 p-3 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
              >
                <ModelCodeBadge code={row.code} size="lg" />
                <div class="min-w-0">
                  <div class="truncate text-sm font-semibold text-dark-0">{row.name}</div>
                  <div class="truncate font-mono text-[11px] text-dark-2">
                    {row.base}{row.sub ? ` · ${row.sub}` : ''}
                  </div>
                </div>
                <span class="ml-auto font-mono text-[11px] text-dark-2">
                  {loadingId === row.workflowId ? 'Loading…' : 'Use'}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      {:catch}
        <div class="py-10 text-center font-mono text-sm text-red-400">Couldn't load your trainings.</div>
      {/await}
    {/if}
  </Dialog.Content>
</Dialog.Root>
