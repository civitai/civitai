<script lang="ts">
  import { IconLayoutGrid } from '@tabler/icons-svelte';
  import Notice from '$lib/components/Notice.svelte';
  import { IMPRESSIONS_SINCE_LABEL, IMPRESSIONS_FULL_LABEL } from '$lib/impressions';
</script>

<div class="mb-4">
  <Notice icon={IconLayoutGrid}>
    <strong class="font-medium text-white">Feed impressions are new.</strong> We started counting on
    {IMPRESSIONS_SINCE_LABEL} and reached every visitor on {IMPRESSIONS_FULL_LABEL}, so there is
    nothing before those dates and totals will look low until a full month has been counted.
  </Notice>
</div>
