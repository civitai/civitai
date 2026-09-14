<script lang="ts">
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import { feedbackAttachmentItems, type FeedbackContext } from '$lib/feedback';

  let { context }: { context: FeedbackContext } = $props();

  /**
   * 🔴 BUILT FROM THE SPLIT CONTEXT, NEVER FROM `row.context`. `FeedbackContext` is what
   * `splitContext` returns, so both id fields have already been through `IMAGE_KEY` — the filter that
   * stops a stored, client-supplied value reaching `<img src>` verbatim via `getEdgeUrl`. This
   * component is typed to accept nothing else, and `feedbackAttachmentItems` is typed the same way,
   * so there is no shape of this page that can route raw JSONB into either the thumbnails or the
   * lightbox.
   */
  const items = $derived(feedbackAttachmentItems(context));

  let openIndex = $state<number | null>(null);
</script>

<section class="flex min-w-0 flex-col gap-2">
  <h3 class="text-xs tracking-wide text-dark-2 uppercase">Attachments</h3>

  {#if items.length}
    <!-- 🔴 Unverified, client-supplied ids: a page capture can carry NSFW content or another user's
         UI. ROW-LEVEL EXPANSION IS THE CONTAINMENT, AND IT IS THE ONLY ONE — nothing loads until a
         moderator opens a row, and this section then renders on the default tab alongside the
         message. It does NOT sit behind a tab of its own; that was tried and reverted, because a
         second gate behind an existing one bought little and cost the message+attachment pairing two
         navigations. So do NOT hoist these into the list view — that is the gate that matters. If
         this page ever reaches a non-moderator, add `blur={40}` and a click to clear. -->
    <div class="flex flex-wrap gap-3">
      <!-- 🔴 KEYED BY INDEX, NOT BY `item.id`, AND THAT IS NOT LAZINESS. `splitContext` deduplicates
           `images` among THEMSELVES, but nothing compares `screenshotId` against them — so a row
           where the reporter attached the same file the page capture produced holds the id twice,
           and `{#each … (item.id)}` THROWS on a duplicate key in production as well as in dev,
           making that report permanently unopenable. That is the exact failure the dedup in
           `splitContext` exists to prevent, reintroduced one layer up.
           Index is safe here: this list is derived from immutable row data and never reorders. -->
      {#each items as item, i (i)}
        <figure class="flex flex-col gap-1">
          <!-- A real <button>: the large view is opened by keyboard as well as by pointer, and it is
               this element that focus returns to when the lightbox closes. -->
          <button
            type="button"
            class="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onclick={() => (openIndex = i)}
            aria-label={`Open attachment ${i + 1} of ${items.length} — ${item.caption}`}
          >
            <EdgeImage
              src={item.id}
              width={320}
              class="max-h-64 w-auto max-w-full rounded-lg border border-dark-4"
            />
          </button>
          <figcaption class="text-xs text-dark-2">{item.caption}</figcaption>
        </figure>
      {/each}
    </div>
  {:else}
    <p class="text-sm text-dark-2">(none)</p>
  {/if}
</section>

<Lightbox
  {items}
  index={openIndex}
  onIndex={(next) => (openIndex = next)}
  onClose={() => (openIndex = null)}
/>
