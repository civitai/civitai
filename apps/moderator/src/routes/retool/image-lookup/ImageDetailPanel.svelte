<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { entityUrl, userUrl, userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { PageData } from './$types';

  type Image = NonNullable<PageData['result']>['image'];

  let { image, civitaiUrl }: { image: Image; civitaiUrl: string } = $props();

  const imageUrl = $derived(entityUrl(civitaiUrl, 'image', image.id));
  const postUrl = $derived(entityUrl(civitaiUrl, 'post', image.postId));

  const fields = $derived<[string, string][]>([
    ['Uploaded', dateTime(image.createdAt)],
    ['Scanned', dateTime(image.scannedAt)],
    ['Type', image.type],
    ['Dimensions', image.width && image.height ? `${num(image.width)}×${num(image.height)}` : '—'],
    ['NSFW level', `${image.nsfwLevel}${image.nsfwLevelLocked ? ' (locked)' : ''}`],
    ['Ingestion', image.ingestion],
  ]);
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class="text-lg font-semibold text-white">
      {#if imageUrl}
        <a href={imageUrl} target="_blank" rel="noreferrer" class={LINK_CLASS}>
          Image #{image.id}
        </a>
      {:else}
        Image #{image.id}
      {/if}
    </h2>
    {#if image.tosViolation}
      <Badge variant="destructive">ToS violation</Badge>
    {/if}
    {#if image.needsReview}
      <Badge variant="destructive">needs review: {image.needsReview}</Badge>
    {/if}
    {#if image.blockedFor}
      <Badge variant="destructive">blocked: {image.blockedFor}</Badge>
    {/if}
    {#if image.minor}<Badge variant="destructive">minor</Badge>{/if}
    {#if image.acceptableMinor}<Badge variant="secondary">acceptable minor</Badge>{/if}
    {#if image.poi}<Badge variant="secondary">POI</Badge>{/if}
  </div>

  <div class="mt-2 flex flex-wrap items-baseline gap-x-3 text-sm">
    <span class="text-dark-2">by</span>
    {#if image.username}
      <a
        href={userUrl(civitaiUrl, image.username)}
        target="_blank"
        rel="noreferrer"
        class={LINK_CLASS}
      >
        {image.username}
      </a>
    {:else}
      <span class="text-dark-0">#{image.userId}</span>
    {/if}
    {#if image.userBannedAt}
      <Badge variant="destructive">uploader banned</Badge>
    {/if}
    <a href={userLookupUrl(image.userId)} class={LINK_CLASS}>look up uploader</a>
    {#if postUrl}
      <a href={postUrl} target="_blank" rel="noreferrer" class={LINK_CLASS}>post {image.postId}</a>
    {/if}
  </div>

  <div class="mt-4 flex flex-col gap-4 sm:flex-row">
    <!-- An image lookup that does not show the image makes the moderator open a second tab to answer
         "what am I even looking at". `url` is the Cloudflare key, which is exactly EdgeMedia's `src`. -->
    <EdgeMedia
      src={image.url}
      name={image.name}
      type={image.type}
      width={450}
      alt="Image {image.id}"
      class="max-h-64 w-auto shrink-0 rounded-lg border border-dark-4"
    />

    <dl class="grid flex-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {#each fields as [label, value] (label)}
        <div>
          <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
          <dd class="text-dark-0">{value}</dd>
        </div>
      {/each}
    </dl>
  </div>
</section>
