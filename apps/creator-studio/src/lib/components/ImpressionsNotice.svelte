<script lang="ts">
  import { IconLayoutGrid } from '@tabler/icons-svelte';
  import { IMPRESSIONS_SINCE_LABEL, IMPRESSIONS_FULL_LABEL } from '$lib/impressions';
</script>

<div
  class="mb-4 flex items-start gap-2 rounded-lg border border-dark-4 bg-dark-7 px-3 py-2 text-xs text-dark-2"
>
  <IconLayoutGrid size={15} class="mt-px shrink-0 text-white" />
  <p>
    <strong class="font-medium text-white">Feed impressions are new.</strong> We started counting on
    {IMPRESSIONS_SINCE_LABEL} and reached every visitor on {IMPRESSIONS_FULL_LABEL}, so there is
    nothing before those dates and totals will look low until a full month has been counted.
  </p>
</div>
