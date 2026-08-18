<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { SvelteSet } from 'svelte/reactivity';
  import ImageCardModTools from './ImageCardModTools.svelte';
  import TosDeleteButton from './TosDeleteButton.svelte';
  import VerdictBadge from './VerdictBadge.svelte';

  let {
    item,
    reportId,
    minorQueue = false,
    verdict,
    selected,
    submit,
  }: {
    item: { id: number; nsfwLevel: number; minor: boolean; poi: boolean };
    /** Couples the report's status to the verdict: accept → Unactioned, block → Actioned. It is also
     *  the card's selection key on the reported queue, where cards key by report rather than image. */
    reportId?: number;
    /** The minor queue's extra button. Plain Accept keeps the flag for SFW and auto-clears it for R+,
     *  which is decided server-side. */
    minorQueue?: boolean;
    verdict: string | undefined;
    selected: SvelteSet<string | number>;
    submit: SubmitFunction;
  } = $props();

  const button = 'rounded border px-2 py-0.5 text-xs font-semibold transition';
</script>

{#if verdict}
  <VerdictBadge {verdict} />
{:else}
  <ImageCardModTools
    imageIds={String(item.id)}
    nsfwLevel={item.nsfwLevel}
    minor={item.minor}
    poi={item.poi}
  />
  <!-- A selected card loses its own verdict buttons: pressing Accept there acted on the one image
       while the moderator believed it applied to the batch. -->
  {#if selected.has(reportId ?? item.id)}
    <span class="text-xs text-primary">In selection — accept or delete it from the bar below.</span>
  {:else}
    <div class="flex flex-wrap gap-1.5">
      <form method="POST" action="?/accept" use:enhance={submit}>
        <input type="hidden" name="imageId" value={item.id} />
        {#if reportId}<input type="hidden" name="reportId" value={reportId} />{/if}
        <button
          type="submit"
          class="{button} border-teal-600/40 text-teal-400 hover:bg-teal-500/10"
        >
          Accept
        </button>
      </form>
      {#if minorQueue}
        <form method="POST" action="?/accept" use:enhance={submit}>
          <input type="hidden" name="imageId" value={item.id} />
          <input type="hidden" name="removeMinorFlag" value="true" />
          <button
            type="submit"
            class="{button} border-cyan-600/40 text-cyan-400 hover:bg-cyan-500/10"
          >
            Accept + clear minor
          </button>
        </form>
      {/if}
      <TosDeleteButton
        action="?/block"
        {submit}
        hidden={reportId ? { imageId: item.id, reportId } : { imageId: item.id }}
      />
    </div>
  {/if}
{/if}
