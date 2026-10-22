<script lang="ts">
  import type { ModelRulesHoldField, ModelRulesHoldMatch } from '@civitai/moderation/model-rules';
  import { fieldSegments, spansForField } from '$lib/model-rule-holds-highlight';

  let {
    fields,
    matches,
  }: { fields: ModelRulesHoldField[]; matches: ModelRulesHoldMatch[] } = $props();

  // Offsets come from the stored match, so a term that also appears elsewhere in a field stays plain.
  const rendered = $derived(
    fields.map((field, index) => ({
      ...field,
      segments: fieldSegments(field.text, spansForField(matches, index)),
    }))
  );
</script>

<div class="space-y-3">
  {#each rendered as field, i (i)}
    <div>
      <p class="m-0 mb-1 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase">
        {field.heading}
      </p>
      <!-- Focusable so a keyboard user can scroll the text (WCAG 2.1.1). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        tabindex="0"
        role="region"
        aria-label={`Scanned ${field.heading}`}
        class="max-h-72 overflow-y-auto text-sm leading-relaxed break-words whitespace-pre-wrap text-dark-0"
      >{#each field.segments as segment, j (j)}{#if segment.hit}<mark
            class="rounded-sm bg-amber-500/30 px-0.5 text-amber-100">{segment.text}</mark
          >{:else}{segment.text}{/if}{/each}{#if !field.text}<span class="text-dark-2">(empty)</span>{/if}</div>
    </div>
  {:else}
    <p class="m-0 text-dark-2">This hold stored no text.</p>
  {/each}
</div>
