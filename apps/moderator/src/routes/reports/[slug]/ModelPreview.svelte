<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { IconPlayerPlayFilled } from '@tabler/icons-svelte';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import { getVideoUrls } from '$lib/media/edge-url';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import type { LightboxItem } from '$lib/lightbox';
  import { bytes, dateTime } from '$lib/format';
  import type { ModelPreview } from '$lib/server/model-preview.service';

  /**
   * What the model page shows a visitor first — its showcase images and description — with the files
   * it ships, the uploader and the model's report history, so most reports can be judged without
   * leaving the queue. Where the model stands now is beside the actions, not here.
   * The "View model" link above stays for everything this leaves out.
   */
  let {
    modelId,
    reportId,
    civitaiUrl,
  }: { modelId: number; reportId: number; civitaiUrl: string } = $props();

  // Derived, never assigned from an effect: a new report is a new promise, so a slow response for the
  // previous one can never land over this one.
  const preview = $derived(
    browser
      ? fetch(`/api/model-preview/${modelId}?report=${reportId}`).then(
          (r): Promise<ModelPreview> => {
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
          }
        )
      : null
  );

  // Images only: `Lightbox` renders through `EdgeImage`, which cannot play a video. Videos play inline.
  // The parent keys this component on the report, so an open frame cannot carry over to another model.
  let openIndex = $state<number | null>(null);

  /**
   * The one video playing, or null. 🔴 THUMBNAILS ARE STILL FRAMES, AND A VIDEO PLAYS ONLY WHEN CLICKED.
   * The grid used `EdgeMedia` → `EdgeVideo`, which autoplays whatever is on screen and loops it:
   * twelve tiles meant up to twelve videos decoding at once, and every loop restarted the decode. Mods
   * reported the whole page freezing, and freezing again on each loop. One player, with controls, no
   * loop, nothing fetched until it is asked for. The parent keys this component on the report, so a
   * playing video stops when the report changes.
   */
  let playingId = $state<number | null>(null);

  const lightboxItems = (p: ModelPreview): LightboxItem[] =>
    p.images
      .filter((i) => i.type === 'image')
      .map((i) => ({ id: i.url, caption: `Image #${i.id}${i.blocked ? ' · already removed' : ''}` }));

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
        <div class="grid grid-cols-3 gap-1.5 2xl:grid-cols-4">
          {#each p.images as image (image.id)}
            {@const lightboxIndex = items.findIndex((i) => i.id === image.url)}
            <div class="relative aspect-square overflow-hidden rounded-md border bg-muted/40">
              <!-- `anim={false}` on every thumbnail: an animated WebP or GIF in the grid costs what a
                   looping video does, and the still frame is enough to decide whether to open it. -->
              {#if image.type === 'image'}
                <button
                  type="button"
                  class="h-full w-full"
                  aria-label={`Enlarge image #${image.id}`}
                  onclick={() => (openIndex = lightboxIndex)}
                >
                  <EdgeImage
                    src={image.url}
                    width={320}
                    anim={false}
                    loading="lazy"
                    class="h-full w-full object-cover"
                  />
                </button>
              {:else if playingId === image.id}
                {@const urls = getVideoUrls(image.url, { width: 450 })}
                <video
                  class="h-full w-full bg-black object-contain"
                  poster={urls.poster}
                  controls
                  autoplay
                  muted
                  playsinline
                  disablepictureinpicture
                  preload="auto"
                  onended={() => (playingId = null)}
                >
                  <source src={urls.webm} type="video/webm" />
                  <source src={urls.mp4} type="video/mp4" />
                </video>
              {:else}
                <button
                  type="button"
                  class="relative h-full w-full"
                  aria-label={`Play video #${image.id}`}
                  onclick={() => (playingId = image.id)}
                >
                  <EdgeImage
                    src={image.url}
                    width={320}
                    anim={false}
                    loading="lazy"
                    class="h-full w-full object-cover"
                  />
                  <span
                    class="absolute inset-0 flex items-center justify-center bg-black/25 text-white"
                    aria-hidden="true"
                  >
                    <IconPlayerPlayFilled size={28} />
                  </span>
                </button>
              {/if}
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
          {p.otherReports.total} other report{p.otherReports.total === 1 ? '' : 's'} on this model{#if Object.keys(p.otherReports.byStatus).length}:
            {reportSummary(p.otherReports.byStatus)}{/if}.
        {:else}
          No other reports on this model.
        {/if}
      </p>
    </div>

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
