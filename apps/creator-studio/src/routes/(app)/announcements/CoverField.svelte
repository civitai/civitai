<script lang="ts">
  import { IconPhotoPlus } from '@tabler/icons-svelte';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import { COVER_ASPECT_LABEL, coverAspectWarning } from '$lib/announcements';
  import { COVER_ACCEPT, COVER_MAX_BYTES, uploadCover, type CoverUpload } from './cover-upload';

  let {
    cover = $bindable(),
    existingUrl = null,
  }: { cover: CoverUpload | null; existingUrl?: string | null } = $props();

  let input = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);
  let uploading = $state(false);
  let error = $state<string | null>(null);

  // A warning, not a rejection: a non-square cover still publishes, it just gets cropped.
  let aspectWarning = $derived(coverAspectWarning(cover?.width, cover?.height));

  // The blob outlives the component otherwise; replacement is handled in take().
  $effect(() => () => {
    if (cover) URL.revokeObjectURL(cover.previewUrl);
  });

  async function take(file: File | undefined) {
    if (!file) return;

    error = null;
    uploading = true;
    try {
      const next = await uploadCover(file);
      if (cover) URL.revokeObjectURL(cover.previewUrl);
      cover = next;
    } catch (e) {
      error = e instanceof Error ? e.message : 'The image could not be uploaded.';
    } finally {
      uploading = false;
      if (input) input.value = '';
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    take(event.dataTransfer?.files?.[0]);
  }
</script>

<div class="flex flex-col gap-1.5">
  <Label for="announcement-cover">Cover image</Label>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="button"
    tabindex="0"
    aria-label="Choose a cover image"
    class="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center transition-colors {dragging
      ? 'border-blue-4 bg-blue-4/10'
      : 'border-dark-4 hover:border-dark-3'}"
    onclick={() => input?.click()}
    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && input?.click()}
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    {#if cover}
      <img src={cover.previewUrl} alt="" class="size-28 rounded-lg object-cover" />
      <span class="text-sm text-dark-2">Drop another image, or click to replace.</span>
    {:else if existingUrl}
      <EdgeImage src={existingUrl} width={220} alt="" class="size-28 rounded-lg object-cover" />
      <span class="text-sm text-dark-2">Drop a new image, or click to replace this one.</span>
    {:else}
      <IconPhotoPlus size={28} class="text-dark-2" />
      <span class="text-sm text-dark-2">
        {uploading ? 'Uploading…' : 'Drop an image here, or click to choose one'}
      </span>
      <span class="text-xs text-dark-2"
        >JPEG, PNG or WebP, up to {COVER_MAX_BYTES / 1024 / 1024}MB</span
      >
    {/if}
  </div>

  <span class="text-xs text-dark-2">{COVER_ASPECT_LABEL}</span>

  <input
    bind:this={input}
    id="announcement-cover"
    type="file"
    accept={COVER_ACCEPT}
    class="hidden"
    disabled={uploading}
    onchange={(e) => take((e.currentTarget as HTMLInputElement).files?.[0])}
  />

  {#if uploading && (cover || existingUrl)}
    <span class="text-sm text-dark-2">Uploading…</span>
  {/if}
  {#if aspectWarning}<p class="text-xs text-yellow-5">{aspectWarning}</p>{/if}
  {#if error}<p class="text-sm text-red-300">{error}</p>{/if}
</div>
