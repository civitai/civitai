<script lang="ts">
  import { browser } from '$app/environment';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { IconDownload } from '@tabler/icons-svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import TrainingDataSheet from '$lib/components/TrainingDataSheet.svelte';
  import type { LightboxItem } from '$lib/lightbox';
  import { bytes, dateTime } from '$lib/format';
  import type { ModelPreview } from '$lib/server/model-preview.service';
  import { SSR_PENDING } from '$lib/ssr-pending';

  /**
   * What the model page shows a visitor first — its showcase images and description — with the files
   * it ships, the uploader and the model's report history, so a model can be judged without leaving
   * the queue. The middle column of the model report queue and of every Model Flags tab; where the
   * model stands now is beside the actions, not here. The page's link to the model stays for
   * everything this leaves out.
   */
  let {
    modelId,
    reportId,
    civitaiUrl,
    canViewTrainingData,
  }: {
    modelId: number;
    /** The report being read, left out of "other reports on this model"; null outside a report queue. */
    reportId: number | null;
    civitaiUrl: string;
    /** Holds a training page grant — the same test `/api/training-data` applies to the viewer's fetch. */
    canViewTrainingData: boolean;
  } = $props();

  // Derived, never assigned from an effect: a new report is a new promise, so a slow response for the
  // previous one can never land over this one. `SSR_PENDING`, not `null`, on the server: with null the
  // previous report's preview stayed stuck above every later one (see that file).
  const preview = $derived(
    browser
      ? fetch(`/api/model-preview/${modelId}${reportId != null ? `?report=${reportId}` : ''}`).then(
          (r): Promise<ModelPreview> => {
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
          }
        )
      : SSR_PENDING
  );

  // Every tile opens the large view, images and videos alike — a video is watched there, with
  // controls, not in a 6rem square. The parent keys this component on the report, so an open frame
  // cannot carry over to another model.
  let openIndex = $state<number | null>(null);

  // Training data is viewed, never downloaded: it can be CSAM, and a download leaves a copy on the
  // moderator's disk. The sheet unpacks the zip in memory and releases it on close.
  let trainingVersion = $state<{ id: number; title: string } | null>(null);
  let trainingOpen = $state(false);
  const isTrainingData = (f: { type: string }) => f.type === 'Training Data';

  const lightboxItems = (p: ModelPreview): LightboxItem[] =>
    p.images.map((i) => ({
      id: i.url,
      type: i.type,
      caption: `${i.type === 'video' ? 'Video' : 'Image'} #${i.id}${i.blocked ? ' · already removed' : ''}`,
    }));

  // Clean files say nothing: a column of "Success" badges would bury the one that is not.
  const scanState = (f: { pickleScan: string; virusScan: string }) => {
    if (f.pickleScan === 'Danger' || f.virusScan === 'Danger')
      return {
        label: f.virusScan === 'Danger' ? 'Virus detected' : 'Unsafe pickle',
        class: 'border-red-500/40 bg-red-500/15 text-red-300',
      };
    const amber = 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    if (f.pickleScan === 'Error' || f.virusScan === 'Error') return { label: 'Scan failed', class: amber };
    if (f.pickleScan !== 'Success' || f.virusScan !== 'Success')
      return { label: 'Not scanned yet', class: amber };
    return null;
  };

  const reportSummary = (byStatus: Record<string, number>) =>
    Object.entries(byStatus)
      .map(([status, n]) => `${n} ${status.toLowerCase()}`)
      .join(', ');
</script>

{#await preview}
  <p class="text-sm text-muted-foreground">Loading the model…</p>
{:then p}
  {#if p}
    {@const items = lightboxItems(p)}
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span class="text-muted-foreground">by</span>
        {#if p.username}
          <a href={`${civitaiUrl}/user/${p.username}`} target="_blank" rel="noreferrer" class="link">
            {p.username}
          </a>
        {:else}
          <span>user #{p.userId}</span>
        {/if}
        {#if p.userBanned}<Badge variant="outline">Banned</Badge>{/if}
        <span class="text-muted-foreground">· {p.type} · {dateTime(p.createdAt)}</span>
      </div>

      {#if p.images.length}
        <!-- One row that scrolls sideways, so the versions and description stay in view. -->
        <div class="flex gap-1.5 overflow-x-auto pb-1">
          {#each p.images as image, i (image.id)}
            <div class="relative size-40 shrink-0 overflow-hidden rounded-md border bg-muted/40">
              <!-- `anim={false}`: a still frame. On a video `EdgeVideo` then never plays by itself —
                   poster and play icon, nothing fetched until hovered, no loop — and leaves the click to
                   this button. Its default autoplays what is in view and loops it, and a grid of those
                   decoded every video at once and again on each loop: mods reported the page freezing.
                   An animated WebP or GIF costs the same, so images get the still frame too. -->
              <button
                type="button"
                class="h-full w-full"
                aria-label={`Open ${image.type} #${image.id}`}
                onclick={() => (openIndex = i)}
              >
                <EdgeMedia
                  src={image.url}
                  type={image.type}
                  width={320}
                  anim={false}
                  class="h-full w-full object-cover"
                />
              </button>
              <span
                class="pointer-events-none absolute top-1 left-1 flex flex-wrap gap-1 text-[10px] font-semibold text-white"
              >
                <span class="rounded bg-black/60 px-1.5 py-px">{getBrowsingLevelLabel(image.nsfwLevel)}</span>
                {#if image.minor}
                  <span class="rounded bg-destructive px-1.5 py-px">minor</span>
                {:else if image.acceptableMinor}
                  <span class="rounded bg-secondary px-1.5 py-px text-secondary-foreground">
                    acceptable minor
                  </span>
                {/if}
              </span>
              {#if image.blocked}
                <span class="absolute inset-x-0 bottom-0 bg-black/70 px-1 text-center text-[10px]">
                  Removed
                </span>
              {/if}
            </div>
          {/each}
        </div>
        {#if p.moreImages}
          <p class="text-xs text-muted-foreground">More images on the model page.</p>
        {/if}
      {:else}
        <p class="text-sm text-muted-foreground">The owner has posted no images to this model.</p>
      {/if}

      <!-- Versions and the files each ships. A file is often the whole report — a pickle where a
           safetensor belongs, a "model" that is a zip, training data nobody should be serving — and it
           was invisible from here. Scan results are spelled out only when they are not clean. -->
      <section aria-label="Versions and files" class="flex flex-col gap-2">
        <h3 class="m-0 text-sm font-semibold">
          {p.versions.length} version{p.versions.length === 1 ? '' : 's'}
        </h3>
        {#each p.versions as v (v.id)}
          <div class="rounded-md border">
            <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b px-3 py-2">
              <span class="text-sm font-medium">{v.name}</span>
              <span class="text-xs text-muted-foreground">
                {v.baseModel} · {v.status}{v.publishedAt ? ` · ${dateTime(v.publishedAt)}` : ''}
              </span>
            </div>
            {#if v.files.length}
              <ul class="divide-y text-xs">
                {#each v.files as file (file.id)}
                  {@const flagged = scanState(file)}
                  <li class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
                    <span class="min-w-0 flex-1 truncate font-mono" title={file.name}>{file.name}</span>
                    <span class="text-muted-foreground">
                      {file.type}{file.format ? ` · ${file.format}` : ''} · {bytes(file.sizeKB)}
                    </span>
                    {#if file.visibility !== 'Public'}<Badge variant="outline">{file.visibility}</Badge>{/if}
                    {#if flagged}<Badge class={flagged.class}>{flagged.label}</Badge>{/if}
                    {#if isTrainingData(file)}
                      {#if canViewTrainingData}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          class="h-6 px-2 text-xs"
                          onclick={() => {
                            trainingVersion = { id: v.id, title: `Training data · ${v.name}` };
                            trainingOpen = true;
                          }}
                        >
                          View
                        </Button>
                      {/if}
                    {:else}
                      <!-- The site's own download route, by file id, on the moderator's civitai.com
                           session — so the file they get is the one listed, scan state and all. -->
                      <a
                        href={`${civitaiUrl}/api/download/models/${v.id}?fileId=${file.id}`}
                        class="link inline-flex items-center"
                        aria-label={`Download ${file.name}`}
                        title="Download from Civitai"
                      >
                        <IconDownload size={14} />
                      </a>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="m-0 px-3 py-2 text-xs text-muted-foreground">No files.</p>
            {/if}
          </div>
        {/each}
      </section>

      {#if p.description}
        <!-- Plain text, never the HTML: an owner-written body rendered in a moderator's session is an
             injection surface, and the words are what is being judged. -->
        <p class="whitespace-pre-line rounded-md border bg-muted/40 p-2 text-sm">
          {p.description.text}
        </p>
      {:else}
        <p class="text-sm text-muted-foreground">No description.</p>
      {/if}

      {#if p.tags.length}
        <div class="flex flex-wrap gap-1">
          {#each p.tags.slice(0, 12) as tag (tag)}
            <Badge variant="outline" class="text-xs">{tag}</Badge>
          {/each}
        </div>
      {/if}

      <p class="text-xs text-muted-foreground">
        {#if p.otherReports.total}
          {p.otherReports.total}{reportId != null ? ' other' : ''} report{p.otherReports.total === 1 ? '' : 's'} on this model{#if Object.keys(p.otherReports.byStatus).length}:
            {reportSummary(p.otherReports.byStatus)}{/if}.
        {:else}
          No {reportId != null ? 'other ' : ''}reports on this model.
        {/if}
      </p>
    </div>

    {#if trainingVersion}
      <TrainingDataSheet bind:open={trainingOpen} versionId={trainingVersion.id} title={trainingVersion.title} />
    {/if}

    <Lightbox
      {items}
      index={openIndex}
      onIndex={(next) => (openIndex = next)}
      onClose={() => (openIndex = null)}
      label="Model image"
    />
  {/if}
{:catch}
  <p class="text-sm text-red-300">Could not load the model preview.</p>
{/await}
