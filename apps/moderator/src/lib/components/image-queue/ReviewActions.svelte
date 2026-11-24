<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { SvelteSet } from 'svelte/reactivity';
  import { offersImageFlags } from '$lib/music/song-card';
  import ImageCardModTools from './ImageCardModTools.svelte';
  import TosDeleteButton from './TosDeleteButton.svelte';
  import VerdictBadge from './VerdictBadge.svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cardRemovals } from '$lib/music/song-tos';

  let {
    item,
    reportId,
    minorQueue = false,
    reported = false,
    dismissFlag = false,
    verdict,
    selected,
    submit,
  }: {
    /** `version` comes with a review-queue item, the only kind `dismissFlag` is shown for.
     *  `needsReview`, when the queue shows it, is posted with Accept so a flag changed since is refused. */
    item: {
      id: number;
      nsfwLevel: number;
      minor: boolean;
      poi: boolean;
      type?: string | null;
      version?: string;
      needsReview?: string | null;
      type?: string | null;
      /** A song's cover, while there is one to remove: "Remove cover" beside "Remove song". */
      songCoverId?: number | null;
    };
    /** Couples the report's status to the verdict: accept → Unactioned, block → Actioned. It is also
     *  the card's selection key on the reported queue, where cards key by report rather than image. */
    reportId?: number;
    /** The minor queue's extra button. Plain Accept keeps the flag for SFW and auto-clears it for R+,
     *  which is decided server-side. */
    minorQueue?: boolean;
    /** Which queue this is. Not inferred from `reportId`: they agree only by accident today, and a
     *  second report-carrying call site would then label the same gesture two different ways. */
    reported?: boolean;
    /** The image is removed and only its review flag is left (`isFlagOnlyRemaining`), so clearing
     *  the flag is the only verdict offered. */
    dismissFlag?: boolean;
    verdict: string | undefined;
    selected: SvelteSet<string | number>;
    submit: SubmitFunction;
  } = $props();

  const button = 'rounded border px-2 py-0.5 text-xs font-semibold transition';

  const acceptLabel = $derived(reported ? 'Unaction' : 'Accept');

  const removals = $derived(cardRemovals(item, reportId));

  // "Remove cover" marks this card, not the card the page's `submit` would key by the cover's id
  // (on Image reports that is a report id, which could be another card's). A held removal is not a
  // removal: the page shows the hold, and the button stays.
  let coverRemoved = $state(false);
  const coverSubmit: SubmitFunction = () => {
    coverRemoved = true;
    return async ({ result, update }) => {
      coverRemoved = result.type === 'success' && !result.data?.held;
      await update({ invalidateAll: false });
    };
  };
</script>

{#if verdict}
  <VerdictBadge {verdict} />
{:else}
  <ImageCardModTools
    imageIds={String(item.id)}
    nsfwLevel={item.nsfwLevel}
    minor={item.minor}
    poi={item.poi}
    rating={!dismissFlag}
    flags={offersImageFlags(item)}
  />
  <!-- Dismiss is per card only, so it stays on the card even while the card is selected. -->
  {#if dismissFlag}
    <form method="POST" action="?/dismissFlag" use:enhance={submit}>
      <input type="hidden" name="imageId" value={item.id} />
      <input type="hidden" name="version" value={item.version} />
      <Button type="submit" variant="outline" size="sm" class="text-amber-400 hover:text-amber-300">
        Dismiss, keep removed
      </Button>
    </form>
  {:else if selected.has(reportId ?? item.id)}
    <!-- A selected card loses its own verdict buttons: pressing Accept there acted on the one image
         while the moderator believed it applied to the batch. -->
    <span class="text-xs text-primary">
      In selection — {acceptLabel.toLowerCase()} or remove it from the bar below.
    </span>
  {:else}
    <div class="flex flex-wrap gap-1.5">
      <form method="POST" action="?/accept" use:enhance={submit}>
        <input type="hidden" name="imageId" value={item.id} />
        {#if item.needsReview !== undefined}<input type="hidden" name="needsReview" value={item.needsReview ?? ''} />{/if}
        {#if reportId}<input type="hidden" name="reportId" value={reportId} />{/if}
        <button
          type="submit"
          class="{button} border-teal-600/40 text-teal-400 hover:bg-teal-500/10"
        >
          {acceptLabel}
        </button>
      </form>
      {#if minorQueue}
        <form method="POST" action="?/accept" use:enhance={submit}>
          <input type="hidden" name="imageId" value={item.id} />
          {#if item.needsReview !== undefined}<input type="hidden" name="needsReview" value={item.needsReview ?? ''} />{/if}
          <input type="hidden" name="removeMinorFlag" value="true" />
          <button
            type="submit"
            class="{button} border-cyan-600/40 text-cyan-400 hover:bg-cyan-500/10"
          >
            Accept + clear minor
          </button>
        </form>
      {/if}
      {#each removals as removal (removal.kind)}
        {#if removal.kind !== 'cover'}
          <TosDeleteButton action="?/block" {submit} hidden={removal.hidden} label={removal.label} />
        {:else if coverRemoved}
          <span class="self-center text-xs text-dark-2">Cover removed</span>
        {:else}
          <TosDeleteButton
            action="?/block"
            submit={coverSubmit}
            hidden={removal.hidden}
            label={removal.label}
          />
        {/if}
      {/each}
    </div>
  {/if}
{/if}
