<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['result']>;

  let { tags, shadowTags }: { tags: Result['tags']; shadowTags: Result['shadowTags'] } = $props();

  const pct = (confidence: number | null) =>
    confidence === null ? null : `${Math.round(confidence)}%`;

  // A join, written as one. The previous version concatenated three conditionals inside a template
  // interpolation and used string truthiness as a null test, which only worked because `pct` happens to
  // return null rather than ''.
  const meta = (tag: Result['tags'][number]) =>
    [tag.automated ? 'automated' : 'manual', tag.source, pct(tag.confidence)]
      .filter(Boolean)
      .join(' · ');
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">Tags ({tags.length})</h3>
    <p class="mb-3 text-xs text-dark-2">
      A disabled tag is one already overridden; needs-review is one the scanner was unsure about.
    </p>
    {#if tags.length === 0}
      <p class="text-sm text-dark-2">No tags on this image.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each tags as tag (tag.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <span class={tag.disabled ? 'text-dark-2 line-through' : 'text-dark-0'}>{tag.name}</span>
            {#if tag.nsfwLevel > 1}<Badge variant="secondary">level {tag.nsfwLevel}</Badge>{/if}
            {#if tag.needsReview}<Badge variant="destructive">needs review</Badge>{/if}
            {#if tag.isCategory}<Badge variant="secondary">category</Badge>{/if}
            <span class="text-xs text-dark-2">{meta(tag)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">Shadow tags ({shadowTags.length})</h3>
    <p class="mb-3 text-xs text-dark-2">
      Tags the scanner matched but did not apply — why an image can be flagged without showing the tag.
    </p>
    {#if shadowTags.length === 0}
      <p class="text-sm text-dark-2">None.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each shadowTags as tag (tag.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-dark-0">{tag.name}</span>
            {#if tag.confidence !== null}
              <span class="text-xs text-dark-2">{pct(tag.confidence)}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
