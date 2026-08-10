<script lang="ts">
  import { MONETIZATION_RIGHTS_AFFIRMATION_STATEMENT } from '@civitai/buzz';

  // The wording is the legal record — it's stored verbatim per version alongside the tick, so a caller
  // must not paraphrase it.
  let {
    checked = $bindable(false),
    note,
  }: {
    checked?: boolean;
    note?: string;
  } = $props();
</script>

<label class="flex w-full items-start gap-2 text-xs text-dark-1">
  <input type="checkbox" name="rightsAffirmed" bind:checked class="mt-0.5 shrink-0" />
  <span>
    {MONETIZATION_RIGHTS_AFFIRMATION_STATEMENT}
    {#if note}
      <span class="block text-dark-2">{note}</span>
    {/if}
  </span>
</label>
