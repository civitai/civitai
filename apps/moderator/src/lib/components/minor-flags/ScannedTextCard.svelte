<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime } from '$lib/format';
  import { ago } from '$lib/minor-flags/appeal-row';
  import type { FlagLabel } from '$lib/minor-flags/text-scan-verdicts';

  let {
    title,
    label,
    detection,
    flagged,
    explanation,
  }: {
    title: string;
    label: FlagLabel;
    detection: { at?: string; reason?: string; names?: string[] };
    /** Whether the model carries this label's flag right now. */
    flagged: boolean;
    explanation: string;
  } = $props();
</script>

<TriageCard {title}>
  <div class="space-y-2 text-base text-dark-0">
    <p class="m-0">
      Text scan: {label === 'poi' ? 'real person' : 'minor'}
      {#if detection.at}
        <span class="text-sm text-dark-2" title={dateTime(detection.at)}>
          · detected {ago(detection.at)}
        </span>
      {/if}
    </p>
    <p class="m-0 text-sm">{detection.reason ?? 'No reason recorded.'}</p>
    {#if detection.names?.length}
      <p class="m-0 text-sm">Names: {detection.names.join(', ')}</p>
    {/if}
    <p class="m-0 text-sm">
      Now:
      <span class={flagged ? 'font-medium text-red-300' : 'font-medium text-emerald-300'}>
        {flagged ? 'Currently flagged' : 'Not flagged'}
      </span>
    </p>
    <p class="m-0 text-sm text-dark-2">{explanation}</p>
  </div>
</TriageCard>
