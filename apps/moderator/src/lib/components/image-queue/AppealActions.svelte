<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import RulingForm, { emptyRulingDraft, type RulingDraft } from '$lib/components/RulingForm.svelte';
  import { appealRulingChoices } from '$lib/ruling-choices';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import ImageCardModTools from './ImageCardModTools.svelte';
  import VerdictBadge from './VerdictBadge.svelte';

  let {
    item,
    verdict,
    selected,
    messages,
    drafts,
    submit,
  }: {
    item: { id: number; minor: boolean; poi: boolean };
    verdict: string | undefined;
    selected: SvelteSet<string | number>;
    /** imageId → resolution message. Held by the page so it survives this card re-rendering. */
    messages: SvelteMap<number, string>;
    /** imageId → the ruling being drafted. Held by the page for the same reason: the card swaps to its
     *  verdict badge on submit and back on a refusal, which would otherwise come back empty. */
    drafts: SvelteMap<number, RulingDraft<ResolutionVerdict<'appeal'>>>;
    submit: SubmitFunction;
  } = $props();

  type Verdict = ResolutionVerdict<'appeal'>;
  const CHOICES = appealRulingChoices();
</script>

{#if verdict}
  <VerdictBadge {verdict} />
{:else}
  <div class="flex flex-col gap-1.5">
    <!-- No rating: an appeal's image is `Blocked`, and setting a level writes `nsfwLevelLocked` over
         a state the decision below is about to replace. -->
    <ImageCardModTools
      imageIds={String(item.id)}
      nsfwLevel={null}
      rating={false}
      minor={item.minor}
      poi={item.poi}
    />
    <!-- A selected card loses its own verdict buttons: pressing Approve there resolved the one appeal
         while the moderator believed it applied to the batch. -->
    {#if selected.has(item.id)}
      <span class="text-xs text-primary">In selection — resolve it from the bar below.</span>
    {:else}
      <textarea
        placeholder="Message to the user (optional)"
        value={messages.get(item.id) ?? ''}
        oninput={(e) => messages.set(item.id, e.currentTarget.value)}
        rows="2"
        maxlength={1000}
        class="w-full resize-none rounded border border-dark-4 bg-dark-6 px-2 py-1 text-xs"
      ></textarea>
      <RulingForm
        subject="appeal"
        choices={CHOICES}
        action="?/resolveAppeal"
        enhancer={submit}
        idPrefix="appeal-{item.id}"
        size="xs"
        bind:draft={() => drafts.get(item.id) ?? emptyRulingDraft<Verdict>(),
          (d: RulingDraft<Verdict>) => drafts.set(item.id, d)}
      >
        {#snippet hidden()}
          <input type="hidden" name="imageId" value={item.id} />
          <input type="hidden" name="resolvedMessage" value={messages.get(item.id) ?? ''} />
        {/snippet}
      </RulingForm>
    {/if}
  </div>
{/if}
