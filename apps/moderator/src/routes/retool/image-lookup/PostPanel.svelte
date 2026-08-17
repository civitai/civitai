<script lang="ts">
  import { IconAlertTriangle } from '@tabler/icons-svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import ImageFlagBadges from '$lib/components/ImageFlagBadges.svelte';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { PostLookupResult } from '$lib/server/image-lookup.service';

  let {
    result,
    civitaiUrl,
  }: {
    result: PostLookupResult;
    civitaiUrl: string;
  } = $props();

  type Item = PostLookupResult['images'][number];

  const post = $derived(result.post);
  const flagged = $derived(
    result.images.filter((i) => i.tosViolation || i.blockedFor || i.needsReview).length
  );

</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 class="text-lg font-semibold text-white">
        {post.title || `Post #${post.id}`}
      </h2>
      <p class="mt-1 text-sm text-dark-2">
        by
        <a class={LINK_CLASS} href={userLookupUrl(post.userId)}>
          {post.username ?? `#${post.userId}`}
        </a>
        {#if post.userBannedAt}
          <Badge class="ml-1 bg-red-600 text-white">Banned</Badge>
        {/if}
        · {result.images.length} image{result.images.length === 1 ? '' : 's'}
      </p>
    </div>
    <!-- The way out. Every other link on this panel stays in the app, so the one that leaves says so. -->
    <Button
      variant="outline"
      size="sm"
      href="{civitaiUrl}/posts/{post.id}"
      target="_blank"
      rel="noreferrer"
    >
      Open post on site
    </Button>
  </div>

  <div class="mt-4 flex flex-wrap gap-2">
    <Badge variant="secondary">{getBrowsingLevelLabel(post.nsfwLevel)}</Badge>
    {#if post.tosViolation}
      <Badge class="bg-rose-800 text-white">ToS violation</Badge>
    {/if}
    {#if !post.publishedAt}
      <Badge variant="secondary">Unpublished</Badge>
    {/if}
    {#if post.unlisted}
      <Badge variant="secondary">Unlisted</Badge>
    {/if}
    {#if post.availability !== 'Public'}
      <Badge variant="secondary">{post.availability}</Badge>
    {/if}
    {#if post.modelVersionId}
      <Badge variant="secondary">Model version #{post.modelVersionId}</Badge>
    {/if}
  </div>

  <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
    <div><dt class="text-dark-2">Created</dt><dd class="text-white">{dateTime(post.createdAt)}</dd></div>
    <div><dt class="text-dark-2">Published</dt><dd class="text-white">{dateTime(post.publishedAt)}</dd></div>
  </dl>

  {#if post.detail}
    <p class="mt-4 whitespace-pre-wrap text-sm text-dark-2">{post.detail}</p>
  {/if}

  {#if flagged}
    <p class="mt-4 flex items-center gap-2 text-sm text-amber-300">
      <IconAlertTriangle size={16} />
      {flagged} of {result.images.length} already flagged, blocked or awaiting review.
    </p>
  {/if}
</section>

{#snippet imageCard(item: Item)}
  <div class="flex flex-wrap items-center gap-1">
    <ImageFlagBadges
      tosViolation={item.tosViolation}
      blockedFor={item.blockedFor}
      needsReview={item.needsReview}
      minor={item.minor}
      poi={item.poi}
    />
  </div>
  <a class="mt-2 block text-xs {LINK_CLASS}" href="?q={item.id}">
    Image #{item.id} — full detail
  </a>
{/snippet}

<ImageQueueGrid
  items={result.images}
  {civitaiUrl}
  card={imageCard}
  empty="This post has no images."
  endLabel={null}
/>
